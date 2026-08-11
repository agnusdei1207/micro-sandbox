import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('release metadata and platform package contracts verify', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-package.mjs', '--source-only'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
