import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { run, runNpm } from './lib/exec.mjs';
import { publishUnlessPresent } from './lib/npm-publish.mjs';
import { PLATFORMS } from './lib/platforms.mjs';
import { packTarball } from './pack-platform.mjs';
import { packageTarballName } from './package-artifacts.mjs';
import { builtBinarySha256, smokeInstallWithNpm } from './smoke-probe.mjs';

// Usage: npm run release:publish-local -- [--all|--platforms-only|--main-only] [--dry-run [--allow-dirty]]
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const allowDirty = argv.includes('--allow-dirty');
if (allowDirty && !dryRun) throw new Error('--allow-dirty is only permitted with --dry-run');
const modeArguments = argv.filter((argument) => argument !== '--dry-run' && argument !== '--allow-dirty');
const mode = modeArguments[0] ?? '--all';
if (modeArguments.length > 1 || !['--all', '--platforms-only', '--main-only'].includes(mode)) {
  throw new Error(`Unsupported publish mode ${modeArguments.join(' ')}`);
}
const token = process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN;
if (!dryRun && !token) throw new Error('NPM_TOKEN or NODE_AUTH_TOKEN is required');
if (!process.env.npm_execpath) throw new Error('Run this command through npm');

const root = JSON.parse(await readFile('package.json', 'utf8'));
if (!allowDirty) assertCleanTree(root.files ?? []);
const includePlatforms = mode !== '--main-only';
const includeMain = mode !== '--platforms-only';
run(process.execPath, [
  fileURLToPath(new URL('./verify-package.mjs', import.meta.url)),
  ...(includePlatforms ? [] : ['--source-only']),
], { label: 'package verification' });

const authDirectory = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-npm-'));
const stagingDirectory = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-pack-'));
const userconfig = path.join(authDirectory, 'npmrc');
try {
  await writeFile(
    userconfig,
    token ? `//registry.npmjs.org/:_authToken=${token}\n` : '',
    { mode: 0o600 },
  );
  // The main tarball is always staged: platform smoke tests install it.
  const main = { name: root.name, tarball: stage('.', root.name), publish: includeMain };
  const prepared = [];
  if (includePlatforms) {
    for (const platform of PLATFORMS) {
      const tarball = stage(`./${platform.directory}`, platform.name, { platform: true });
      await smokeInstallWithNpm({
        arch: platform.arch,
        version: root.version,
        expectedSha256: builtBinarySha256(platform.arch),
        mainTarball: main.tarball,
        platformTarball: tarball,
      });
      prepared.push({ name: platform.name, tarball });
    }
  }
  if (includeMain) prepared.push(main);

  await mkdir('artifacts', { recursive: true });
  for (const artifact of prepared) {
    const target = path.resolve('artifacts', path.basename(artifact.tarball));
    await copyFile(artifact.tarball, target);
    artifact.target = target;
  }
  if (!dryRun) {
    npm(['whoami'], false);
    for (const artifact of prepared) {
      publishUnlessPresent({
        name: artifact.name,
        version: root.version,
        tarball: artifact.target,
        npm: (args) => npm(args, true),
      });
    }
  }
} finally {
  await rm(authDirectory, { recursive: true, force: true });
  await rm(stagingDirectory, { recursive: true, force: true });
}

function stage(directory, name, options) {
  const tarball = packTarball(directory, stagingDirectory, options);
  const expected = packageTarballName(name, root.version);
  if (path.basename(tarball) !== expected) throw new Error(`Packed ${path.basename(tarball)}; expected ${expected}`);
  return tarball;
}

function npm(args, allowFailure) {
  return runNpm([...args, '--userconfig', userconfig], { capture: true, allowFailure });
}

// Tracked changes anywhere, or untracked files in packaged paths, could make
// the published tarballs differ from the committed source.
function assertCleanTree(packagedPaths) {
  const tracked = run('git', ['status', '--porcelain', '--untracked-files=no'], { capture: true }).stdout.trim();
  const untracked = run('git', [
    'ls-files', '--others', '--exclude-standard', '--',
    ...packagedPaths, 'package.json', 'package-lock.json', 'npm', 'native', 'src',
  ], { capture: true }).stdout.trim();
  const dirty = [tracked, untracked].filter(Boolean).join('\n');
  if (dirty) {
    throw new Error(`Refusing to publish from a dirty working tree (use --dry-run --allow-dirty to rehearse):\n${dirty}`);
  }
}
