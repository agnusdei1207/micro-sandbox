import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { requirePackageTarball } from './package-artifacts.mjs';

const root = JSON.parse(await readFile('package.json', 'utf8'));
const files = await readdir('artifacts');
const packages = [
  'micro-sandbox-linux-x64',
  'micro-sandbox-linux-arm64',
  root.name,
].map((name) => ({
  name,
  target: path.resolve('artifacts', requirePackageTarball(files, name, root.version)),
}));
for (const { name, target } of packages) {
  publishUnlessPresent(name, target);
}

function publishUnlessPresent(name, target) {
  if (run(['view', `${name}@${root.version}`, 'version'], true).status === 0) return;
  const result = run(['publish', target, '--access', 'public', '--provenance'], true);
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status === 0 || alreadyPublished(result)) return;
  process.exit(result.status ?? 1);
}

function run(args, quiet) {
  return spawnSync('npm', args, {
    encoding: 'utf8',
    stdio: quiet ? 'pipe' : 'inherit',
    shell: false,
  });
}

function alreadyPublished(result) {
  return /previously published versions|cannot publish over/i.test(
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  );
}
