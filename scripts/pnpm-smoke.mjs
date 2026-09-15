import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { packageTarballName } from './package-artifacts.mjs';
import { createInstalledPackageProbe } from './smoke-probe.mjs';

const arch = process.argv.find((value) => value.startsWith('--current='))?.split('=')[1] ?? 'x64';
if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported pnpm smoke architecture ${arch}`);
const platform = arch === 'x64' ? 'amd64' : 'arm64';
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const main = packageTarballName(manifest.name, manifest.version);
const native = packageTarballName(`micro-sandbox-linux-${arch}`, manifest.version);
const binary = await readFile(`npm/linux-${arch}/bin/micro-sandbox`);
const expectedSha256 = createHash('sha256').update(binary).digest('hex');
const probe = createInstalledPackageProbe(arch, manifest.version, expectedSha256);
const projectManifest = JSON.stringify({
  private: true,
  type: 'module',
});
const workspaceConfig = `overrides:\n  "micro-sandbox-linux-${arch}": "file:/artifacts/${native}"\n`;
const setupProject = [
  `require('fs').writeFileSync('/tmp/smoke/package.json', ${JSON.stringify(projectManifest)})`,
  `require('fs').writeFileSync('/tmp/smoke/pnpm-workspace.yaml', ${JSON.stringify(workspaceConfig)})`,
].join(';');
const command = [
  'mkdir -p /tmp/smoke',
  `node -e ${quote(setupProject)}`,
  'cd /tmp/smoke',
  'corepack enable',
  `pnpm add --ignore-scripts /artifacts/${main} /artifacts/${native}`,
  `node --input-type=module -e ${quote(probe)}`,
].join(' && ');

const result = spawnSync('docker', [
  'run', '--rm', '--platform', `linux/${platform}`,
  '-v', `${path.resolve('artifacts')}:/artifacts:ro`,
  'node:24.18.0-bookworm', 'bash', '-c', command,
], { stdio: 'inherit', shell: false });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
