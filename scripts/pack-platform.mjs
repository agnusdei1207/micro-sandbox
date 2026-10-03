import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gunzipSync } from 'node:zlib';
import { run, runNpm } from './lib/exec.mjs';
import { IMAGES } from './lib/platforms.mjs';

// Packs `directory` into `destination` and returns the absolute tarball path.
// Windows npm drops the executable bit, so platform packages are packed inside
// Linux there; every platform tarball must carry a 0755 native executable.
export function packTarball(directory, destination, { platform = false } = {}) {
  const result = platform && process.platform === 'win32'
    ? packPlatformInLinux(directory, destination)
    : runNpm(['pack', directory, '--pack-destination', destination, '--json'], {
      capture: true,
      label: `npm pack ${directory}`,
    });
  const [{ filename }] = JSON.parse(result.stdout);
  const tarball = path.resolve(destination, filename);
  if (platform) assertPlatformTarballExecutable(readFileSync(tarball));
  return tarball;
}

export function packPlatformInLinux(directory, destination) {
  return run('docker', [
    'run', '--rm',
    '-v', `${path.resolve(directory)}:/source:ro`,
    '-v', `${path.resolve(destination)}:/artifacts`,
    IMAGES.nodeBookworm, 'bash', '-c',
    'mkdir -p /tmp/micro-sandbox-package && cp -a /source/. /tmp/micro-sandbox-package/ && find /tmp/micro-sandbox-package -type d -exec chmod 755 {} + && find /tmp/micro-sandbox-package -type f -exec chmod 644 {} + && chmod 755 /tmp/micro-sandbox-package/bin/micro-sandbox && npm pack /tmp/micro-sandbox-package --pack-destination /artifacts --json',
  ], { capture: true, label: `docker platform pack ${directory}` });
}

export function assertPlatformTarballExecutable(compressedTarball) {
  const tar = gunzipSync(compressedTarball);
  const expected = 'package/bin/micro-sandbox';
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readText(header, 0, 100);
    const prefix = readText(header, 345, 155);
    const member = prefix ? `${prefix}/${name}` : name;
    const size = readOctal(header, 124, 12, `size for ${member}`);
    if (member === expected) {
      const mode = readOctal(header, 100, 8, `mode for ${member}`);
      if (mode !== 0o755) {
        throw new Error(`${expected} must have archive mode 0755; got 0${mode.toString(8)}`);
      }
      return;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`Platform tarball is missing ${expected}`);
}

function readText(header, start, length) {
  const end = header.indexOf(0, start);
  const boundedEnd = end === -1 || end > start + length ? start + length : end;
  return header.toString('utf8', start, boundedEnd);
}

function readOctal(header, start, length, label) {
  const value = readText(header, start, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error(`Invalid tar ${label}`);
  return Number.parseInt(value, 8);
}
