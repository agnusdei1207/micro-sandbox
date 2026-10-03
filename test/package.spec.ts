import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { verifyOptionalDependencyLock } from '../scripts/package-artifacts.mjs';

test('release verification requires the tag commit or a lockfile-only descendant', () => {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const tag = `v${version}`;
  const repo = mkdtempSync(path.join(tmpdir(), 'micro-sandbox-release-tag-'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  const verify = (releaseTag: string) => spawnSync(
    process.execPath,
    [path.resolve('scripts/verify-release.mjs'), releaseTag],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, GITHUB_REF_NAME: 'main' } },
  );
  const expectFailure = (releaseTag: string, pattern: RegExp) => {
    const result = verify(releaseTag);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, pattern);
  };
  const expectSuccess = (releaseTag: string) => {
    const result = verify(releaseTag);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  };
  try {
    for (const file of [
      'package.json',
      'package-lock.json',
      'native/Cargo.toml',
      'native/Cargo.lock',
      'npm/linux-x64/package.json',
      'npm/linux-arm64/package.json',
    ]) {
      cpSync(file, path.join(repo, file), { recursive: true });
    }
    git('init', '--quiet');
    git('add', '.');
    git('commit', '--quiet', '-m', 'base');
    git('branch', 'base');
    expectFailure(tag, /does not exist/);

    appendFileSync(path.join(repo, 'package-lock.json'), '\n');
    git('commit', '--quiet', '-am', 'release');
    git('tag', '-a', tag, '-m', tag);
    expectSuccess(tag);
    expectFailure('v999.0.0', /must equal v/);

    appendFileSync(path.join(repo, 'package-lock.json'), '\n');
    git('commit', '--quiet', '-am', 'refresh lockfile');
    expectSuccess(tag);

    writeFileSync(path.join(repo, 'README.md'), 'changed');
    git('add', 'README.md');
    git('commit', '--quiet', '-m', 'unrelated change');
    expectFailure(tag, /differs from release tag .* beyond package-lock\.json/);

    git('checkout', '--quiet', 'base');
    appendFileSync(path.join(repo, 'package-lock.json'), '\n\n');
    git('commit', '--quiet', '-am', 'diverged lockfile');
    expectFailure(tag, /is not a descendant of release tag/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('release metadata and platform package contracts verify', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-package.mjs', '--source-only'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('lockfile represents each platform as published metadata or an unpublished placeholder', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    optionalDependencies: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));

  for (const [name, version] of Object.entries(manifest.optionalDependencies)) {
    verifyOptionalDependencyLock(lock, name, version);
  }
});

test('lockfile permits an unpublished optional package placeholder but rejects partial metadata', () => {
  const name = 'micro-sandbox-linux-x64';
  const version = '0.0.6';
  const root = { optionalDependencies: { [name]: version } };
  const placeholder = {
    packages: {
      '': root,
      [`node_modules/${name}`]: { optional: true },
    },
  };
  assert.equal(verifyOptionalDependencyLock(placeholder, name, version), 'unpublished');

  const partial = structuredClone(placeholder);
  partial.packages[`node_modules/${name}`].version = version;
  assert.throws(
    () => verifyOptionalDependencyLock(partial, name, version),
    /incomplete registry metadata/,
  );
});
