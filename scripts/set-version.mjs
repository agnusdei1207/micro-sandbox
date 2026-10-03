import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { PLATFORMS } from './lib/platforms.mjs';
import {
  VERSION_FILES,
  VERSION_PATTERN,
  assertVersionsSynced,
  replaceCargoLockVersion,
  replaceCargoManifestVersion,
} from './lib/versions.mjs';

// Usage: npm run release:version -- <x.y.z>
// Rewrites every version-bearing file in the current directory. A platform
// lockfile entry whose registry metadata does not match the new version
// becomes an `"optional": true` placeholder until that version is published.
const version = process.argv[2];
if (process.argv.length !== 3 || !VERSION_PATTERN.test(version ?? '')) {
  throw new Error('Usage: npm run release:version -- <major.minor.patch>');
}

const manifest = JSON.parse(await readFile(VERSION_FILES.manifest, 'utf8'));
manifest.version = version;
for (const platform of PLATFORMS) {
  manifest.optionalDependencies ??= {};
  manifest.optionalDependencies[platform.name] = version;
}
await writeJson(VERSION_FILES.manifest, manifest);

for (const platform of PLATFORMS) {
  const file = `${platform.directory}/package.json`;
  const text = await readFile(file, 'utf8');
  // Preserve the compact hand-written formatting of the platform manifests.
  const updated = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (JSON.parse(updated).version !== version) throw new Error(`Could not update ${file}`);
  await writeFile(file, updated);
}

await writeFile(
  VERSION_FILES.cargoManifest,
  replaceCargoManifestVersion(await readFile(VERSION_FILES.cargoManifest, 'utf8'), version),
);
await writeFile(
  VERSION_FILES.cargoLock,
  replaceCargoLockVersion(await readFile(VERSION_FILES.cargoLock, 'utf8'), version),
);

const lock = JSON.parse(await readFile(VERSION_FILES.lock, 'utf8'));
const lockRoot = lock.packages?.[''];
if (!lockRoot) throw new Error('package-lock.json root package entry is missing');
lock.version = version;
lockRoot.version = version;
lockRoot.optionalDependencies ??= {};
const placeholders = [];
for (const platform of PLATFORMS) {
  lockRoot.optionalDependencies[platform.name] = version;
  const key = `node_modules/${platform.name}`;
  if (lock.packages[key]?.version !== version) {
    lock.packages[key] = { optional: true };
    placeholders.push(platform.name);
  }
}
await writeJson(VERSION_FILES.lock, lock);

assertVersionsSynced('.');
console.log(`Set version ${version}.`);
if (placeholders.length > 0) {
  console.log(
    `Wrote unpublished lockfile placeholders for ${placeholders.join(', ')}. After publication, run `
    + '`npm install --package-lock-only --ignore-scripts` and commit package-lock.json.',
  );
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
