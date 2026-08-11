import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const root = JSON.parse(await readFile('package.json', 'utf8'));
const files = await readdir('artifacts');
for (const name of ['micro-sandbox-linux-x64', 'micro-sandbox-linux-arm64']) {
  const tarball = files.find((file) => file.startsWith(`${name}-${root.version}`) && file.endsWith('.tgz'));
  if (!tarball) throw new Error(`Missing tarball for ${name}`);
  publishUnlessPresent(name, path.resolve('artifacts', tarball));
}
publishUnlessPresent(root.name, '.');

function publishUnlessPresent(name, target) {
  if (run(['view', `${name}@${root.version}`, 'version'], true).status === 0) return;
  const result = run(['publish', target, '--access', 'public', '--provenance'], false);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function run(args, quiet) {
  return spawnSync('npm', args, { stdio: quiet ? 'ignore' : 'inherit', shell: false });
}
