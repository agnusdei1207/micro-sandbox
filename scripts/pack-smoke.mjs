import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const arch = process.argv.find((value) => value.startsWith('--current='))?.split('=')[1] ?? process.arch;
if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported smoke-test architecture ${arch}`);
const artifacts = path.resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const platformTarball = pack(`./npm/linux-${arch}`);
const rootTarball = pack('.');
const probe = "import { createSandbox } from 'micro-sandbox'; import { access } from 'node:fs/promises'; import { createRequire } from 'node:module'; const require=createRequire(import.meta.url); await access(require.resolve('micro-sandbox-linux-" + arch + "/bin/micro-sandbox')); if(typeof createSandbox!=='function') process.exit(1);";
if (process.platform === 'linux') {
  const project = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-smoke-'));
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', rootTarball, platformTarball], project);
  run('node', ['--input-type=module', '-e', probe], project);
} else {
  const rootName = path.basename(rootTarball);
  const platformName = path.basename(platformTarball);
  run('docker', [
    'run', '--rm', '--platform', `linux/${arch === 'x64' ? 'amd64' : 'arm64'}`,
    '-v', `${process.cwd()}:/work`, '-w', '/tmp/smoke', 'node:24.18.0-bookworm',
    'bash', '-c', `npm init -y >/dev/null && npm install --ignore-scripts /work/artifacts/${rootName} /work/artifacts/${platformName} >/dev/null && node --input-type=module -e ${JSON.stringify(probe)}`,
  ], process.cwd());
}

function pack(directory) {
  const output = run('npm', ['pack', directory, '--pack-destination', artifacts, '--json'], process.cwd(), true);
  const [{ filename }] = JSON.parse(output);
  return path.join(artifacts, filename);
}

function run(command, args, cwd, capture = false) {
  const useNpmCli = command === 'npm' && process.env.npm_execpath;
  const executable = useNpmCli ? process.execPath : command;
  const commandArgs = useNpmCli ? [process.env.npm_execpath, ...args] : args;
  const result = spawnSync(executable, commandArgs, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}: ${result.stderr ?? ''}`);
  return result.stdout ?? '';
}
