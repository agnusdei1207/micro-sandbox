import { readFileSync } from 'node:fs';
import path from 'node:path';
import { verifyOptionalDependencyLock } from '../package-artifacts.mjs';
import { PLATFORMS } from './platforms.mjs';

export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const NATIVE_CRATE = 'micro-sandbox-native';

const CARGO_PACKAGE_VERSION = /(\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/;
const CARGO_LOCK_VERSION = new RegExp(
  `(\\[\\[package\\]\\]\\r?\\nname = "${NATIVE_CRATE}"\\r?\\nversion = ")([^"]+)(")`,
);

export const VERSION_FILES = Object.freeze({
  manifest: 'package.json',
  lock: 'package-lock.json',
  cargoManifest: 'native/Cargo.toml',
  cargoLock: 'native/Cargo.lock',
});

export function cargoManifestVersion(text) {
  return text.match(CARGO_PACKAGE_VERSION)?.[2];
}

export function cargoLockVersion(text) {
  return text.match(CARGO_LOCK_VERSION)?.[2];
}

export function replaceCargoManifestVersion(text, version) {
  if (!CARGO_PACKAGE_VERSION.test(text)) throw new Error('Cargo.toml [package] version is missing');
  return text.replace(CARGO_PACKAGE_VERSION, `$1${version}$3`);
}

export function replaceCargoLockVersion(text, version) {
  if (!CARGO_LOCK_VERSION.test(text)) throw new Error(`Cargo.lock entry for ${NATIVE_CRATE} is missing`);
  return text.replace(CARGO_LOCK_VERSION, `$1${version}$3`);
}

// Checks that every file carrying the release version agrees. Returns the version.
export function assertVersionsSynced(root = '.') {
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  const manifest = JSON.parse(read(VERSION_FILES.manifest));
  const { version } = manifest;
  check(typeof version === 'string' && VERSION_PATTERN.test(version), `main package version ${JSON.stringify(version)} is not x.y.z`);

  const optional = manifest.optionalDependencies ?? {};
  const expectedNames = PLATFORMS.map((platform) => platform.name).sort();
  check(
    JSON.stringify(Object.keys(optional).sort()) === JSON.stringify(expectedNames),
    `optionalDependencies must list exactly ${expectedNames.join(', ')}`,
  );
  for (const platform of PLATFORMS) {
    check(optional[platform.name] === version, `optional dependency ${platform.name} must equal ${version}`);
    const platformManifest = JSON.parse(read(`${platform.directory}/package.json`));
    check(platformManifest.name === platform.name, `${platform.directory} package name must be ${platform.name}`);
    check(platformManifest.version === version, `${platform.name} version ${platformManifest.version} must equal ${version}`);
  }

  const cargoVersion = cargoManifestVersion(read(VERSION_FILES.cargoManifest));
  check(cargoVersion === version, `native/Cargo.toml version ${cargoVersion} must equal ${version}`);
  const cargoLocked = cargoLockVersion(read(VERSION_FILES.cargoLock));
  check(cargoLocked === version, `native/Cargo.lock ${NATIVE_CRATE} version ${cargoLocked} must equal ${version}`);

  const lock = JSON.parse(read(VERSION_FILES.lock));
  check(lock.version === version, `package-lock.json version ${lock.version} must equal ${version}`);
  check(lock.packages?.['']?.version === version, `package-lock.json root package version must equal ${version}`);
  for (const platform of PLATFORMS) {
    verifyOptionalDependencyLock(lock, platform.name, version);
  }
  return version;
}

function check(condition, message) {
  if (!condition) throw new Error(`Version synchronization failed: ${message}`);
}
