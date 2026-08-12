import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('release metadata and platform package contracts verify', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-package.mjs', '--source-only'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('lockfile pins complete platform package metadata', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    optionalDependencies: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
    packages: Record<string, { version?: string; resolved?: string; integrity?: string }>;
  };

  for (const [name, version] of Object.entries(manifest.optionalDependencies)) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(entry?.version, version, `${name} must have a pinned lockfile version`);
    assert.match(entry?.resolved ?? '', /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry?.integrity ?? '', /^sha512-/);
  }
});
