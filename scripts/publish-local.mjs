import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { packageTarballName } from './package-artifacts.mjs';
import { assertPlatformTarballExecutable, packPlatformInLinux } from './pack-platform.mjs';

const dryRun = process.argv.includes('--dry-run');
const modeArguments = process.argv.slice(2).filter((argument) => argument !== '--dry-run');
const mode = modeArguments[0] ?? '--all';
if (modeArguments.length > 1 || !['--all', '--platforms-only', '--main-only'].includes(mode)) {
  throw new Error(`Unsupported publish mode ${modeArguments.join(' ')}`);
}
const token = process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN;
if (!dryRun && !token) throw new Error('NPM_TOKEN or NODE_AUTH_TOKEN is required');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this command through npm');
const authDirectory = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-npm-'));
const stagingDirectory = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-pack-'));
const userconfig = path.join(authDirectory, 'npmrc');

try {
  await writeFile(
    userconfig,
    token ? `//registry.npmjs.org/:_authToken=${token}\n` : '',
    { mode: 0o600 },
  );
  const root = JSON.parse(await readFile('package.json', 'utf8'));
  const packages = [];
  if (mode !== '--main-only') {
    for (const { name, directory } of [
      { name: 'micro-sandbox-linux-x64', directory: './npm/linux-x64' },
      { name: 'micro-sandbox-linux-arm64', directory: './npm/linux-arm64' },
    ]) {
      packages.push({ name, directory });
    }
  }
  if (mode !== '--platforms-only') packages.push({ name: root.name, directory: '.' });

  const prepared = [];
  for (const definition of packages) {
    const filename = pack(definition.name, definition.directory, root.version, stagingDirectory);
    prepared.push({ ...definition, filename });
  }
  await mkdir('artifacts', { recursive: true });
  for (const artifact of prepared) {
    const target = path.resolve('artifacts', artifact.filename);
    await copyFile(path.join(stagingDirectory, artifact.filename), target);
    artifact.target = target;
  }
  if (!dryRun) {
    ensureSuccess(run(['whoami']), 'npm authentication');
    for (const artifact of prepared) {
      publishUnlessPresent(artifact.name, artifact.target, root.version);
    }
  }
} finally {
  await rm(authDirectory, { recursive: true, force: true });
  await rm(stagingDirectory, { recursive: true, force: true });
}

function pack(name, directory, version, destination) {
  const expected = packageTarballName(name, version);
  const result = process.platform === 'win32' && directory.startsWith('./npm/linux-')
    ? packPlatformInLinux(directory, destination)
    : run(['pack', directory, '--pack-destination', destination, '--json'], true);
  ensureSuccess(result, `pack ${name}@${version}`);
  const [{ filename }] = JSON.parse(result.stdout);
  if (filename !== expected) throw new Error(`Packed ${filename}; expected ${expected}`);
  if (directory.startsWith('./npm/linux-')) {
    assertPlatformTarballExecutable(readFileSync(path.join(destination, filename)));
  }
  return filename;
}

function publishUnlessPresent(name, target, version) {
  if (run(['view', `${name}@${version}`, 'version'], true).status === 0) return;
  const result = run(['publish', target, '--access', 'public'], true);
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (alreadyPublished(result)) return;
  ensureSuccess(result, `publish ${name}@${version}`);
}

function ensureSuccess(result, operation) {
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    throw new Error(`${operation} failed with status ${result.status}${detail ? `: ${detail}` : ''}`);
  }
}

function run(args, quiet = false) {
  const result = spawnSync(process.execPath, [npmCli, ...args, '--userconfig', userconfig], {
    encoding: 'utf8',
    stdio: quiet ? 'pipe' : 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}

function alreadyPublished(result) {
  return /previously published versions|cannot publish over/i.test(
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  );
}
