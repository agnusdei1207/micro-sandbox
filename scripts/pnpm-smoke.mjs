import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { run, shQuote } from './lib/exec.mjs';
import { IMAGES, parseCurrentArch, platformFor } from './lib/platforms.mjs';
import { packageTarballName } from './package-artifacts.mjs';
import { builtBinarySha256, createInstalledPackageProbe } from './smoke-probe.mjs';

const arch = parseCurrentArch(process.argv, { fallback: 'x64', label: 'pnpm smoke' });
const platform = platformFor(arch);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const main = `/artifacts/${packageTarballName(manifest.name, manifest.version)}`;
const native = `/artifacts/${packageTarballName(platform.name, manifest.version)}`;
const probe = createInstalledPackageProbe(arch, manifest.version, builtBinarySha256(arch));
const projectManifest = JSON.stringify({
  private: true,
  type: 'module',
});
const workspaceConfig = `overrides:\n  ${JSON.stringify(platform.name)}: ${JSON.stringify(`file:${native}`)}\n`;
const setupProject = [
  `require('fs').writeFileSync('/tmp/smoke/package.json', ${JSON.stringify(projectManifest)})`,
  `require('fs').writeFileSync('/tmp/smoke/pnpm-workspace.yaml', ${JSON.stringify(workspaceConfig)})`,
].join(';');
const command = [
  'mkdir -p /tmp/smoke',
  `node -e ${shQuote(setupProject)}`,
  'cd /tmp/smoke',
  'corepack enable',
  `pnpm add --ignore-scripts ${shQuote(main)} ${shQuote(native)}`,
  `node --input-type=module -e ${shQuote(probe)}`,
].join(' && ');

run('docker', [
  'run', '--rm', '--platform', platform.dockerPlatform,
  '-v', `${path.resolve('artifacts')}:/artifacts:ro`,
  IMAGES.nodeBookworm, 'bash', '-c', command,
], { label: `pnpm install smoke for ${arch}` });
