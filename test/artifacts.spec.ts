import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectArtifacts, prepareWorkspace } from '../dist/artifacts/workspace.js';
import { resolveArtifactLimits } from '../dist/policy/artifacts.js';

test('artifact policy preserves aggregate limits and rejects invalid overrides', () => {
  const limits = resolveArtifactLimits({}, {}, { outputBytes: 1024 });
  assert.equal(limits.outputFileBytes, 1024);
  assert.equal(Object.isFrozen(limits), true);
  for (const requested of [{ inputFiles: 0 }, { inputBytes: NaN }, { outputFiles: 257 }, { outputFileBytes: 1.5 }]) {
    assert.throws(() => resolveArtifactLimits({}, {}, requested), { code: 'POLICY_VIOLATION' });
  }
});

test('artifact source files are staged and declared outputs are independently checked', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'micro-artifact-test-'));
  try {
    await writeFile(path.join(root, 'source'), 'input');
    const workspace = await prepareWorkspace(root, {
      inputs: [{ target: 'nested/input', sourcePath: path.join(root, 'source') }],
      outputs: [{ path: 'result', maxBytes: 4 }, { path: 'optional', maxBytes: 4, required: false }],
    }, resolveArtifactLimits({}, {}, {}));
    assert.equal(await readFile(path.join(workspace.path, 'input/nested/input'), 'utf8'), 'input');
    await writeFile(path.join(workspace.path, 'output/result'), 'data');
    const manifest = [{ path: 'result', size: 4, sha256: createHash('sha256').update('data').digest('hex') }];
    assert.equal((await collectArtifacts(workspace, manifest))[0].data.toString(), 'data');
    for (const invalid of [
      [{ ...manifest[0], path: '../result' }],
      [{ ...manifest[0], path: 'undeclared' }],
      [manifest[0], manifest[0]],
      [{ ...manifest[0], size: 5 }],
      [{ ...manifest[0], sha256: '0'.repeat(64) }],
    ]) {
      await assert.rejects(collectArtifacts(workspace, invalid), { code: 'POLICY_VIOLATION' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact manifests reject malformed entries with a stable error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'micro-artifact-test-'));
  try {
    const workspace = await prepareWorkspace(root, {}, resolveArtifactLimits({}, {}, {}));
    for (const entry of [null, {}, { path: 1, size: 0, sha256: '' }]) {
      await assert.rejects(collectArtifacts(workspace, [entry] as never), { code: 'POLICY_VIOLATION' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact input names cannot collide with output duplicate tracking', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'micro-artifact-test-'));
  try {
    const workspace = await prepareWorkspace(root, {
      inputs: [{ target: 'output:result', data: 'input' }],
      outputs: [{ path: 'result' }],
    }, resolveArtifactLimits({}, {}, {}));
    assert.equal(await readFile(path.join(workspace.path, 'input/output:result'), 'utf8'), 'input');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
