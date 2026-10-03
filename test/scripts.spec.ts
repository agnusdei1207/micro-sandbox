import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { publishUnlessPresent, tarballIntegrity } from '../scripts/lib/npm-publish.mjs';
import { PLATFORMS, parseCurrentArch } from '../scripts/lib/platforms.mjs';
import { assertVersionsSynced } from '../scripts/lib/versions.mjs';
import { assertPlatformTarballExecutable } from '../scripts/pack-platform.mjs';
import {
  packageTarballName,
  requirePackageTarball,
  verifyOptionalDependencyLock,
} from '../scripts/package-artifacts.mjs';
import { stageReleaseArtifacts, verifyReleaseArtifacts } from '../scripts/release-artifacts.mjs';
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
    /Unsupported smoke probe architecture "ppc64"/,
  );
  assert.throws(
    () => createInstalledPackageProbe('x64', '0.0.5'),
    /Expected native SHA-256 is invalid/,
  );
});

test('local publish dry run verifies and replaces a stale main tarball without registry access', async () => {
  const fixture = await copyVersionFixture({ withDocs: true });
  const artifacts = path.join(fixture, 'artifacts');
  const fakeNpm = path.join(fixture, 'fake-npm.mjs');
  const { name, version } = JSON.parse(await readFile(path.join(fixture, 'package.json'), 'utf8'));
  const expected = packageTarballName(name, version);
  try {
    await mkdir(artifacts);
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

    const env = { ...process.env, npm_execpath: fakeNpm, NPM_TOKEN: '', NODE_AUTH_TOKEN: '' };
    const script = path.resolve('scripts/publish-local.mjs');

    const unsafe = spawnSync(process.execPath, [script, '--main-only', '--allow-dirty'], {
      cwd: fixture,
      encoding: 'utf8',
      env: { ...env, NPM_TOKEN: 'unused' },
    });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /--allow-dirty is only permitted with --dry-run/);

    const result = spawnSync(process.execPath, [script, '--main-only', '--dry-run', '--allow-dirty'], {
      cwd: fixture,
      encoding: 'utf8',
      env,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await readFile(path.join(artifacts, expected), 'utf8'), `fresh:${version}`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('set-version synchronizes every version file in a copy of the repository', async () => {
  const fixture = await copyVersionFixture();
  const script = path.resolve('scripts/set-version.mjs');
  try {
    const cargoBefore = await readFile(path.join(fixture, 'native/Cargo.toml'), 'utf8');
    const result = spawnSync(process.execPath, [script, '9.8.7'], { cwd: fixture, encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(assertVersionsSynced(fixture), '9.8.7');

    const manifest = JSON.parse(await readFile(path.join(fixture, 'package.json'), 'utf8'));
    assert.equal(manifest.version, '9.8.7');
    assert.deepEqual(manifest.optionalDependencies, {
      'micro-sandbox-linux-arm64': '9.8.7',
      'micro-sandbox-linux-x64': '9.8.7',
    });
    const lock = JSON.parse(await readFile(path.join(fixture, 'package-lock.json'), 'utf8'));
    assert.equal(lock.version, '9.8.7');
    assert.equal(lock.packages[''].version, '9.8.7');
    for (const platform of PLATFORMS) {
      assert.deepEqual(lock.packages[`node_modules/${platform.name}`], { optional: true });
      assert.equal(verifyOptionalDependencyLock(lock, platform.name, '9.8.7'), 'unpublished');
      const platformText = await readFile(path.join(fixture, platform.directory, 'package.json'), 'utf8');
      assert.match(platformText, /"version": "9\.8\.7"/);
      assert.match(platformText, /"os": \["linux"\]/, 'compact platform manifest formatting is preserved');
    }
    assert.equal(
      await readFile(path.join(fixture, 'native/Cargo.toml'), 'utf8'),
      cargoBefore.replace(/^version = "[^"]+"/m, 'version = "9.8.7"'),
    );
    assert.match(
      await readFile(path.join(fixture, 'native/Cargo.lock'), 'utf8'),
      /name = "micro-sandbox-native"\r?\nversion = "9\.8\.7"/,
    );

    // Re-running with the same version keeps the placeholders and is idempotent.
    const again = spawnSync(process.execPath, [script, '9.8.7'], { cwd: fixture, encoding: 'utf8' });
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);

    for (const invalid of [[], ['9.8'], ['v9.8.7'], ['9.8.7', 'extra']]) {
      const rejected = spawnSync(process.execPath, [script, ...invalid], { cwd: fixture, encoding: 'utf8' });
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /Usage: npm run release:version/);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('version synchronization rejects a drifted Cargo manifest', async () => {
  const fixture = await copyVersionFixture();
  try {
    const file = path.join(fixture, 'native/Cargo.toml');
    const cargo = await readFile(file, 'utf8');
    await writeFile(file, cargo.replace(/^version = "[^"]+"/m, 'version = "0.0.0"'));
    assert.throws(() => assertVersionsSynced(fixture), /native\/Cargo\.toml version 0\.0\.0/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('architecture selection uses explicit per-script defaults', () => {
  assert.equal(parseCurrentArch([], {}), undefined);
  assert.equal(parseCurrentArch([], { fallback: 'x64' }), 'x64');
  assert.equal(parseCurrentArch(['--current=arm64'], { fallback: 'x64' }), 'arm64');
  assert.throws(
    () => parseCurrentArch([], { fallback: 'ia32', label: 'smoke-test' }),
    /Unsupported smoke-test architecture "ia32"/,
  );
});

test('publication skips an existing version only when its integrity matches', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-integrity-'));
  const tarball = path.join(fixture, 'package.tgz');
  type NpmResult = { status: number; stdout?: string; stderr?: string };
  const registry = (view: NpmResult, calls: string[][] = []) => (args: string[]) => {
    calls.push(args);
    if (args[0] === 'view') return view;
    if (args[0] === 'publish') return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected npm ${args.join(' ')}`);
  };
  try {
    await writeFile(tarball, 'tarball bytes');
    const local = tarballIntegrity(Buffer.from('tarball bytes'));
    const options = { name: 'example', version: '1.0.0', tarball, log: () => {} };

    const matching: string[][] = [];
    assert.equal(
      publishUnlessPresent({ ...options, npm: registry({ status: 0, stdout: JSON.stringify(local) }, matching) }),
      'present',
    );
    assert.deepEqual(matching.map(([command]) => command), ['view']);

    const other = JSON.stringify(tarballIntegrity(Buffer.from('other bytes')));
    assert.throws(
      () => publishUnlessPresent({ ...options, npm: registry({ status: 0, stdout: other }) }),
      /already published with different contents/,
    );

    const missing: string[][] = [];
    assert.equal(
      publishUnlessPresent({
        ...options,
        provenance: true,
        npm: registry({ status: 1, stderr: 'npm error code E404' }, missing),
      }),
      'published',
    );
    assert.deepEqual(missing[1], ['publish', tarball, '--access', 'public', '--provenance']);

    assert.throws(
      () => publishUnlessPresent({ ...options, npm: registry({ status: 1, stderr: 'npm error code ETIMEDOUT' }) }),
      /npm view example@1\.0\.0 failed/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('release artifacts carry the main tarball once and verify checksum coverage', async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-release-'));
  const mainName = '@example/sandbox';
  const version = '1.2.3';
  const allNames = [mainName, ...PLATFORMS.map((platform) => platform.name)];
  try {
    const source = path.join(fixture, 'source');
    await mkdir(source);
    for (const name of allNames) {
      await writeFile(path.join(source, packageTarballName(name, version)), name);
    }
    const merged = path.join(fixture, 'merged');
    for (const { arch } of PLATFORMS) {
      const destination = path.join(fixture, arch);
      stageReleaseArtifacts({ arch, mainName, version, source, destination });
      await cp(destination, merged, { recursive: true });
    }
    const main = packageTarballName(mainName, version);
    assert.ok((await readdir(path.join(fixture, 'x64'))).includes(main));
    assert.ok(!(await readdir(path.join(fixture, 'arm64'))).includes(main));
    const tarballs = verifyReleaseArtifacts({ directory: merged, mainName, version });
    assert.deepEqual([...tarballs.keys()].sort(), [...allNames].sort());

    const arm64Sums = path.join(merged, 'SHA256SUMS-arm64');
    const original = await readFile(arm64Sums, 'utf8');
    const mainLine = (await readFile(path.join(merged, 'SHA256SUMS-x64'), 'utf8'))
      .split('\n')
      .find((line) => line.endsWith(main));
    await writeFile(arm64Sums, `${original}${mainLine}\n`);
    assert.throws(
      () => verifyReleaseArtifacts({ directory: merged, mainName, version }),
      /listed in more than one checksum file/,
    );

    await writeFile(arm64Sums, original);
    await writeFile(path.join(merged, main), 'tampered');
    assert.throws(() => verifyReleaseArtifacts({ directory: merged, mainName, version }), /Checksum mismatch/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function copyVersionFixture({ withDocs = false } = {}) {
  const fixture = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-version-'));
  const files = [
    'package.json',
    'package-lock.json',
    'native/Cargo.toml',
    'native/Cargo.lock',
    ...PLATFORMS.map((platform) => `${platform.directory}/package.json`),
    ...(withDocs ? ['README.md', 'docs'] : []),
  ];
  for (const file of files) {
    await cp(file, path.join(fixture, file), { recursive: true });
  }
  return fixture;
}

function platformTarballWithMode(mode: number) {
  const tar = Buffer.alloc(1024);
  tar.write('package/bin/micro-sandbox', 0, 'utf8');
  tar.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  tar.write('00000000000\0', 124, 'ascii');
  tar[156] = '0'.charCodeAt(0);
  return gzipSync(tar);
}
