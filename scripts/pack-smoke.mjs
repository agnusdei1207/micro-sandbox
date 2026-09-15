import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { assertPlatformTarballExecutable, packPlatformInLinux } from './pack-platform.mjs';
import { createInstalledPackageProbe } from './smoke-probe.mjs';

const arch = process.argv.find((value) => value.startsWith('--current='))?.split('=')[1] ?? process.arch;
if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported smoke-test architecture ${arch}`);
const artifacts = path.resolve('artifacts');
await mkdir(artifacts, { recursive: true });
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const binary = await readFile(`npm/linux-${arch}/bin/micro-sandbox`);
const expectedSha256 = createHash('sha256').update(binary).digest('hex');
const platformTarball = packPlatform(`./npm/linux-${arch}`);
const rootTarball = pack('.');
const probe = createInstalledPackageProbe(arch, manifest.version, expectedSha256);
if (process.platform === 'linux') {
  const project = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-smoke-'));
  try {
    await writeFile(path.join(project, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run('npm', ['install', '--ignore-scripts', rootTarball, platformTarball], project);
    run('node', ['--input-type=module', '-e', probe], project);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
} else {
  const rootName = path.basename(rootTarball);
  const platformName = path.basename(platformTarball);
  run('docker', [
    'run', '--rm', '--platform', `linux/${arch === 'x64' ? 'amd64' : 'arm64'}`,
    '-v', `${process.cwd()}:/work`, '-w', '/tmp/smoke', 'node:24.18.0-bookworm',
    'bash', '-c', `npm init -y >/dev/null && npm install --ignore-scripts /work/artifacts/${rootName} /work/artifacts/${platformName} >/dev/null && node --input-type=module -e ${quote(probe)}`,
  ], process.cwd());
}

function pack(directory) {
  const output = run('npm', ['pack', directory, '--pack-destination', artifacts, '--json'], process.cwd(), true);
  const [{ filename }] = JSON.parse(output);
  return path.join(artifacts, filename);
}

function packPlatform(directory) {
  if (process.platform !== 'win32') {
    const tarball = pack(directory);
    assertPlatformTarballExecutable(readFileSync(tarball));
    return tarball;
  }
  const result = packPlatformInLinux(directory, artifacts);
  if (result.status !== 0) {
    throw new Error(`docker platform pack failed with status ${result.status}: ${result.stderr ?? ''}`);
  }
  const [{ filename }] = JSON.parse(result.stdout);
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

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
