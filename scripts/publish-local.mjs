import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const token = process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN;
if (!token) throw new Error('NPM_TOKEN or NODE_AUTH_TOKEN is required');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this command through npm');
const authDirectory = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-npm-'));
const userconfig = path.join(authDirectory, 'npmrc');

try {
  await writeFile(userconfig, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 });
  ensureSuccess(run(['whoami']), 'npm authentication');
  const root = JSON.parse(await readFile('package.json', 'utf8'));
  const mode = process.argv[2] ?? '--all';
  if (!['--all', '--platforms-only', '--main-only'].includes(mode)) {
    throw new Error(`Unsupported publish mode ${mode}`);
  }
  if (mode !== '--main-only') {
    for (const { name, directory } of [
      { name: 'micro-sandbox-linux-x64', directory: './npm/linux-x64' },
      { name: 'micro-sandbox-linux-arm64', directory: './npm/linux-arm64' },
    ]) {
      const tarball = await ensureTarball(name, directory, root.version);
      publishUnlessPresent(name, path.resolve('artifacts', tarball), root.version);
    }
  }
  if (mode !== '--platforms-only') publishUnlessPresent(root.name, '.', root.version);
} finally {
  await rm(authDirectory, { recursive: true, force: true });
}

async function ensureTarball(name, directory, version) {
  const expected = `${name}-${version}.tgz`;
  await mkdir('artifacts', { recursive: true });
  if ((await readdir('artifacts')).includes(expected)) return expected;
  const result = run(['pack', directory, '--pack-destination', 'artifacts', '--json'], true);
  ensureSuccess(result, `pack ${name}@${version}`);
  const [{ filename }] = JSON.parse(result.stdout);
  if (filename !== expected) throw new Error(`Packed ${filename}; expected ${expected}`);
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
