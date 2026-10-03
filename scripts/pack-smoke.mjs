import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { packTarball } from './pack-platform.mjs';
import { parseCurrentArch, platformFor } from './lib/platforms.mjs';
import { builtBinarySha256, smokeInstallWithNpm } from './smoke-probe.mjs';

const arch = parseCurrentArch(process.argv, { fallback: process.arch, label: 'smoke-test' });
const artifacts = path.resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const platformTarball = packTarball(`./${platformFor(arch).directory}`, artifacts, { platform: true });
const mainTarball = packTarball('.', artifacts);
await smokeInstallWithNpm({
  arch,
  version: manifest.version,
  expectedSha256: builtBinarySha256(arch),
  mainTarball,
  platformTarball,
});
