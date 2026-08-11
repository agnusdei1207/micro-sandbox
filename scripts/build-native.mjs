import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
  throw new Error('Native builds require Linux x64 or ARM64');
}
const result = spawnSync('cargo', ['build', '--jobs', '2', '--locked', '--release', '--manifest-path', 'native/Cargo.toml'], {
  stdio: 'inherit',
  shell: false,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const destination = `npm/linux-${process.arch}/bin/micro-sandbox`;
await mkdir(`npm/linux-${process.arch}/bin`, { recursive: true });
await copyFile('native/target/release/micro-sandbox', destination);
await chmod(destination, 0o755);
