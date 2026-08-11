import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
    const files = await readdir('artifacts');
    for (const name of ['micro-sandbox-linux-x64', 'micro-sandbox-linux-arm64']) {
      const tarball = files.find((file) => file === `${name}-${root.version}.tgz`);
      if (!tarball) throw new Error(`Missing ${name} tarball`);
      publishUnlessPresent(name, path.resolve('artifacts', tarball), root.version);
    }
  }
  if (mode !== '--platforms-only') publishUnlessPresent(root.name, '.', root.version);
} finally {
  await rm(authDirectory, { recursive: true, force: true });
}

function publishUnlessPresent(name, target, version) {
  if (run(['view', `${name}@${version}`, 'version'], true).status === 0) return;
  const result = run(['publish', target, '--access', 'public']);
  ensureSuccess(result, `publish ${name}@${version}`);
}

function ensureSuccess(result, operation) {
  if (result.status !== 0) throw new Error(`${operation} failed with status ${result.status}`);
}

function run(args, quiet = false) {
  const result = spawnSync(process.execPath, [npmCli, ...args, '--userconfig', userconfig], {
    stdio: quiet ? 'ignore' : 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}
