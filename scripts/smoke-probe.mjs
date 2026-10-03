import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { run, runNpm, shQuote } from './lib/exec.mjs';
import { IMAGES, MAIN_PACKAGE, platformFor } from './lib/platforms.mjs';

export function createInstalledPackageProbe(arch, version, expectedSha256) {
  const { name: nativePackage } = platformFor(arch, 'smoke probe');
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? '')) {
    throw new Error('Expected native SHA-256 is invalid');
  }
  return `
const { spawnSync } = await import('node:child_process');
const { createHash } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const { createRequire } = await import('node:module');
const mainUrl = import.meta.resolve(${JSON.stringify(MAIN_PACKAGE)});
const packageRequire = createRequire(mainUrl);
const binary = packageRequire.resolve(${JSON.stringify(`${nativePackage}/bin/micro-sandbox`)});
const installedSha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
if (installedSha256 !== ${JSON.stringify(expectedSha256)}) {
  throw new Error('installed native executable does not match the built binary');
}
const native = spawnSync(binary, ['--version'], { encoding: 'utf8', shell: false });
if (native.error) throw native.error;
if (native.status !== 0) throw new Error('native executable failed: ' + (native.stderr || native.status));
if (native.stdout.trim() !== ${JSON.stringify(`micro-sandbox ${version}`)}) {
  throw new Error('native executable version mismatch: ' + native.stdout.trim());
}
const api = await import(mainUrl);
if (typeof api.createSandbox !== 'function') throw new Error('createSandbox export is unavailable');
`;
}

export function builtBinarySha256(arch) {
  const binary = readFileSync(`${platformFor(arch).directory}/bin/micro-sandbox`);
  return createHash('sha256').update(binary).digest('hex');
}

// Installs both tarballs with npm into a clean project for `arch` and runs the
// probe. Uses the host when it matches, otherwise a pinned Linux container.
export async function smokeInstallWithNpm({ arch, version, expectedSha256, mainTarball, platformTarball }) {
  const platform = platformFor(arch, 'smoke-test');
  const probe = createInstalledPackageProbe(arch, version, expectedSha256);
  if (process.platform === 'linux' && process.arch === arch) {
    const project = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-smoke-'));
    try {
      await writeFile(path.join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      runNpm(['install', '--ignore-scripts', mainTarball, platformTarball], { cwd: project });
      run(process.execPath, ['--input-type=module', '-e', probe], { cwd: project, label: 'installed package probe' });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
    return;
  }
  const main = `/packages/main/${path.basename(mainTarball)}`;
  const native = `/packages/platform/${path.basename(platformTarball)}`;
  run('docker', [
    'run', '--rm', '--platform', platform.dockerPlatform,
    '-v', `${path.dirname(path.resolve(mainTarball))}:/packages/main:ro`,
    '-v', `${path.dirname(path.resolve(platformTarball))}:/packages/platform:ro`,
    '-w', '/tmp/smoke', IMAGES.nodeBookworm,
    'bash', '-c',
    `npm init -y >/dev/null && npm install --ignore-scripts ${shQuote(main)} ${shQuote(native)} >/dev/null && node --input-type=module -e ${shQuote(probe)}`,
  ], { label: `npm install smoke for ${arch}` });
}
