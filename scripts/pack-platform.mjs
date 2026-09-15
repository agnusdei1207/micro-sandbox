import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export function packPlatformInLinux(directory, destination) {
  const result = spawnSync('docker', [
    'run', '--rm',
    '-v', `${path.resolve(directory)}:/source:ro`,
    '-v', `${path.resolve(destination)}:/artifacts`,
    'node:24.18.0-bookworm', 'bash', '-c',
    'mkdir -p /tmp/micro-sandbox-package && cp -a /source/. /tmp/micro-sandbox-package/ && find /tmp/micro-sandbox-package -type d -exec chmod 755 {} + && find /tmp/micro-sandbox-package -type f -exec chmod 644 {} + && chmod 755 /tmp/micro-sandbox-package/bin/micro-sandbox && npm pack /tmp/micro-sandbox-package --pack-destination /artifacts --json',
  ], { encoding: 'utf8', shell: false });
  if (result.error) throw result.error;
  if (result.status === 0) {
    const [{ filename }] = JSON.parse(result.stdout);
    assertPlatformTarballExecutable(readFileSync(path.join(destination, filename)));
  }
  return result;
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
