import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const arch = process.argv.find((value) => value.startsWith('--current='))?.split('=')[1] ?? 'x64';
if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported pnpm smoke architecture ${arch}`);
const platform = arch === 'x64' ? 'amd64' : 'arm64';
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const main = `agnusdei12071207-micro-sandbox-${manifest.version}.tgz`;
const native = `micro-sandbox-linux-${arch}-${manifest.version}.tgz`;
const probe = `const api=await import('@agnusdei12071207/micro-sandbox');if(typeof api.createSandbox!=='function')process.exit(1)`;
const command = [
  'mkdir -p /tmp/smoke',
  `node -e ${quote("require('fs').writeFileSync('/tmp/smoke/package.json', JSON.stringify({private:true,type:'module'}))")}`,
  'cd /tmp/smoke',
  'corepack enable',
  `pnpm add --ignore-scripts /artifacts/${main} /artifacts/${native}`,
  `node --input-type=module -e ${quote(probe)}`,
].join(' && ');

const result = spawnSync('docker', [
  'run', '--rm', '--platform', `linux/${platform}`,
  '-v', `${path.resolve('artifacts')}:/artifacts:ro`,
  'node:24.18.0-bookworm', 'bash', '-c', command,
], { stdio: 'inherit', shell: false });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
