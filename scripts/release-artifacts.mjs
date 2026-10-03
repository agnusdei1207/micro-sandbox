import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { requirePackageTarball } from './package-artifacts.mjs';
import { MAIN_ARTIFACT_ARCH, PLATFORMS, parseCurrentArch, platformFor } from './lib/platforms.mjs';

// Each release job uploads only the tarballs it owns plus SHA256SUMS-<arch>:
// its platform package, and the main package from MAIN_ARTIFACT_ARCH only.
export function releasePackagesFor(arch, mainName) {
  return arch === MAIN_ARTIFACT_ARCH ? [platformFor(arch).name, mainName] : [platformFor(arch).name];
}

export function stageReleaseArtifacts({ arch, mainName, version, source, destination }) {
  const files = readdirSync(source);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const lines = [];
  for (const name of releasePackagesFor(arch, mainName)) {
    const filename = requirePackageTarball(files, name, version);
    copyFileSync(path.join(source, filename), path.join(destination, filename));
    lines.push(`${sha256(path.join(destination, filename))}  ${filename}`);
  }
  writeFileSync(path.join(destination, `SHA256SUMS-${arch}`), `${lines.join('\n')}\n`);
}

// Verifies the merged release directory: every expected tarball is listed in
// exactly one SHA256SUMS-<arch> file, nothing else is listed, and each hash
// matches. Returns a map from package name to tarball path.
export function verifyReleaseArtifacts({ directory, mainName, version }) {
  const listed = new Map();
  for (const { arch } of PLATFORMS) {
    const sums = path.join(directory, `SHA256SUMS-${arch}`);
    if (!existsSync(sums)) throw new Error(`Missing checksum file SHA256SUMS-${arch}`);
    for (const line of readFileSync(sums, 'utf8').split('\n').filter(Boolean)) {
      const match = /^([0-9a-f]{64}) {2}([^/\\]+)$/.exec(line);
      if (!match) throw new Error(`Malformed checksum line in SHA256SUMS-${arch}: ${line}`);
      const [, digest, filename] = match;
      if (listed.has(filename)) throw new Error(`${filename} is listed in more than one checksum file`);
      listed.set(filename, digest);
    }
  }
  const files = readdirSync(directory);
  const expected = new Map(
    PLATFORMS.flatMap(({ arch }) => releasePackagesFor(arch, mainName))
      .map((name) => [name, requirePackageTarball(files, name, version)]),
  );
  const expectedFiles = new Set(expected.values());
  for (const filename of listed.keys()) {
    if (!expectedFiles.has(filename)) throw new Error(`Unexpected release artifact ${filename}`);
  }
  const tarballs = new Map();
  for (const [name, filename] of expected) {
    const digest = listed.get(filename);
    if (!digest) throw new Error(`${filename} is not covered by a checksum file`);
    const target = path.resolve(directory, filename);
    if (sha256(target) !== digest) throw new Error(`Checksum mismatch for ${filename}`);
    tarballs.set(name, target);
  }
  return tarballs;
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command] = process.argv.slice(2);
  const root = JSON.parse(readFileSync('package.json', 'utf8'));
  if (command === 'stage') {
    // Usage: node scripts/release-artifacts.mjs stage --current=<arch>
    const arch = parseCurrentArch(process.argv, { label: 'release artifact' });
    if (arch === undefined) throw new Error('stage requires --current=<arch>');
    stageReleaseArtifacts({
      arch,
      mainName: root.name,
      version: root.version,
      source: 'artifacts',
      destination: path.join('artifacts', 'release'),
    });
  } else if (command === 'verify') {
    // Usage: node scripts/release-artifacts.mjs verify [directory]
    const directory = process.argv[3] ?? 'artifacts';
    const tarballs = verifyReleaseArtifacts({ directory, mainName: root.name, version: root.version });
    console.log(`Verified ${tarballs.size} release tarballs`);
  } else {
    throw new Error('Usage: release-artifacts.mjs stage --current=<arch> | verify [directory]');
  }
}
