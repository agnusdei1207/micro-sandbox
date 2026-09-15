import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { assertPlatformTarballExecutable } from '../scripts/pack-platform.mjs';
import { requirePackageTarball } from '../scripts/package-artifacts.mjs';
import { createInstalledPackageProbe } from '../scripts/smoke-probe.mjs';

function runScript(script: string, args: readonly string[] = [], env = process.env) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env,
  });
}

test('platform build rejects an unknown architecture before invoking Docker', () => {
  for (const value of ['bogus', '']) {
    const result = runScript('scripts/build-platforms.mjs', [`--current=${value}`]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Unsupported build architecture ${JSON.stringify(value)}`));
  }
});

test('package verification rejects an unknown architecture instead of skipping binaries', () => {
  for (const value of ['bogus', '']) {
    const result = runScript('scripts/verify-package.mjs', [`--current=${value}`]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`Unsupported package architecture ${JSON.stringify(value)}`));
  }
});

test('native test runner rejects an unknown mode before invoking Docker', () => {
  const result = runScript('scripts/native.mjs', ['bogus'], {
    ...process.env,
    PATH: '',
    Path: '',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported native test mode bogus/);
});

test('release artifact selection requires each exact package tarball', () => {
  const files = [
    'agnusdei12071207-micro-sandbox-0.0.5.tgz',
    'micro-sandbox-linux-x64-0.0.50.tgz',
  ];
  assert.equal(
    requirePackageTarball(files, '@agnusdei12071207/micro-sandbox', '0.0.5'),
    'agnusdei12071207-micro-sandbox-0.0.5.tgz',
  );
  assert.throws(
    () => requirePackageTarball(files, 'micro-sandbox-linux-x64', '0.0.5'),
    /Missing tarball for micro-sandbox-linux-x64@0\.0\.5/,
  );
});

test('platform tarball requires an executable native member', () => {
  assert.doesNotThrow(() => assertPlatformTarballExecutable(platformTarballWithMode(0o755)));
  assert.throws(
    () => assertPlatformTarballExecutable(platformTarballWithMode(0o644)),
    /must have archive mode 0755; got 0644/,
  );
});

test('installed-package probe is valid module code and rejects unknown architectures', () => {
  const sha256 = 'a'.repeat(64);
  const probe = createInstalledPackageProbe('arm64', '0.0.5', sha256);
  const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    encoding: 'utf8',
    input: probe,
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.throws(
    () => createInstalledPackageProbe('ppc64', '0.0.5', sha256),
    /Unsupported smoke probe architecture ppc64/,
  );
  assert.throws(
    () => createInstalledPackageProbe('x64', '0.0.5'),
    /Expected native SHA-256 is invalid/,
  );
});

test('local publish dry run replaces a stale main tarball without registry access', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-publish-'));
  const artifacts = path.join(fixture, 'artifacts');
  const fakeNpm = path.join(fixture, 'fake-npm.mjs');
  const expected = 'example-sandbox-1.2.3.tgz';
  try {
    await mkdir(artifacts);
    await writeFile(path.join(fixture, 'package.json'), JSON.stringify({
      name: '@example/sandbox',
      version: '1.2.3',
    }));
    await writeFile(path.join(artifacts, expected), 'stale');
    await writeFile(fakeNpm, `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [command, target, destinationFlag, destination] = process.argv.slice(2);
if (command !== 'pack' || destinationFlag !== '--pack-destination') {
  throw new Error('unexpected registry command: ' + process.argv.slice(2).join(' '));
}
const manifest = JSON.parse(readFileSync(path.resolve(target, 'package.json'), 'utf8'));
const slug = manifest.name.slice(1).replaceAll('/', '-');
const filename = slug + '-' + manifest.version + '.tgz';
mkdirSync(destination, { recursive: true });
writeFileSync(path.join(destination, filename), 'fresh:' + manifest.version);
process.stdout.write(JSON.stringify([{ filename }]));
`);

    const result = spawnSync(
      process.execPath,
      [path.resolve('scripts/publish-local.mjs'), '--main-only', '--dry-run'],
      {
        cwd: fixture,
        encoding: 'utf8',
        env: { ...process.env, npm_execpath: fakeNpm, NPM_TOKEN: '', NODE_AUTH_TOKEN: '' },
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(path.join(artifacts, expected), 'utf8'), 'fresh:1.2.3');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

function platformTarballWithMode(mode: number) {
  const tar = Buffer.alloc(1024);
  tar.write('package/bin/micro-sandbox', 0, 'utf8');
  tar.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  tar.write('00000000000\0', 124, 'ascii');
  tar[156] = '0'.charCodeAt(0);
  return gzipSync(tar);
}
