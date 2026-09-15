import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { verifyOptionalDependencyLock } from '../scripts/package-artifacts.mjs';

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
