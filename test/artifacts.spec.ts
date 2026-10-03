import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { collectArtifacts, planArtifacts, prepareWorkspace } from '../dist/artifacts/workspace.js';
import { SandboxError } from '../dist/errors.js';
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
    const workspace = await prepareWorkspace(root, planArtifacts({
      inputs: [{ target: 'nested/input', sourcePath: path.join(root, 'source') }],
      outputs: [{ path: 'result', maxBytes: 4 }, { path: 'optional', maxBytes: 4, required: false }],
    }, resolveArtifactLimits({}, {}, {})));
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
    const workspace = await prepareWorkspace(root, planArtifacts({}, resolveArtifactLimits({}, {}, {})));
    for (const entry of [null, {}, { path: 1, size: 0, sha256: '' }]) {
      await assert.rejects(collectArtifacts(workspace, [entry] as never), { code: 'POLICY_VIOLATION' });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withOutput(
  contents: string,
  check: (workspace: Awaited<ReturnType<typeof prepareWorkspace>>, file: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'micro-artifact-test-'));
  try {
    const workspace = await prepareWorkspace(root, planArtifacts({
      outputs: [{ path: 'result', maxBytes: 64 }],
    }, resolveArtifactLimits({}, {}, {})));
    const file = path.join(workspace.path, 'output/result');
    await writeFile(file, contents);
    await check(workspace, file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test('collectArtifacts rejects size and hash mismatches', async () => {
  await withOutput('data', async (workspace) => {
    await assert.rejects(
      collectArtifacts(workspace, [{ path: 'result', size: 3, sha256: digest('dat') }]),
      { code: 'POLICY_VIOLATION' },
    );
    await assert.rejects(
      collectArtifacts(workspace, [{ path: 'result', size: 4, sha256: digest('DATA') }]),
      { code: 'POLICY_VIOLATION' },
    );
  });
});

test('collectArtifacts rejects a symlinked output', { skip: process.platform === 'win32' }, async () => {
  await withOutput('data', async (workspace, file) => {
    const target = path.join(workspace.path, 'elsewhere');
    await writeFile(target, 'data');
    await rm(file);
    await symlink(target, file);
    await assert.rejects(
      collectArtifacts(workspace, [{ path: 'result', size: 4, sha256: digest('data') }]),
      (error: unknown) => error instanceof SandboxError
        && error.code === 'POLICY_VIOLATION' && error.cause !== undefined,
    );
  });
});

test('collectArtifacts rejects a hard-linked output', { skip: process.platform === 'win32' }, async () => {
  await withOutput('data', async (workspace, file) => {
    await link(file, path.join(workspace.path, 'second-link'));
    await assert.rejects(
      collectArtifacts(workspace, [{ path: 'result', size: 4, sha256: digest('data') }]),
      { code: 'POLICY_VIOLATION' },
    );
  });
});

test('artifact planning validates source types and rejects overlapping paths', () => {
  const limits = resolveArtifactLimits({}, {}, {});
  for (const request of [
    { inputs: [{ target: 'a', data: undefined }] },
    { inputs: [{ target: 'a', data: 42 }] },
    { inputs: [{ target: 'a', sourcePath: '' }] },
    { inputs: [{ target: 'a', stream: {} }] },
    { inputs: [{ target: 'a', iterable: 'not a function' }] },
    { inputs: [{ target: 'a', data: 'x', sourcePath: '/etc/hosts' }] },
    { inputs: [{ target: 'a', data: 'x' }, { target: 'a/b', data: 'y' }] },
    { inputs: [{ target: 'a/b/c', data: 'x' }, { target: 'a/b', data: 'y' }] },
    { outputs: [{ path: 'o' }, { path: 'o/p' }] },
    { outputs: [{ path: 'o', required: 'yes' }] },
    { inputs: 'not-an-array' },
  ]) {
    assert.throws(() => planArtifacts(request as never, limits), { code: 'POLICY_VIOLATION' }, JSON.stringify(request));
  }
  // An explicitly undefined alternative does not count as a second source.
  const plan = planArtifacts({ inputs: [{ target: 'a/b', data: 'x', sourcePath: undefined } as never] }, limits);
  assert.equal(plan.inputs[0]?.target, 'a/b');
});

test('artifact staging wraps source and producer failures and removes the workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'micro-artifact-test-'));
  const limits = resolveArtifactLimits({}, {}, {});
  try {
    await assert.rejects(
      prepareWorkspace(root, planArtifacts({
        inputs: [{ target: 'missing', sourcePath: path.join(root, 'does-not-exist') }],
      }, limits)),
      (error: unknown) => error instanceof SandboxError && error.code === 'POLICY_VIOLATION'
        && (error.cause as { code?: string } | undefined)?.code === 'ENOENT',
    );
    await assert.rejects(
      prepareWorkspace(root, planArtifacts({
        inputs: [{ target: 'bad', iterable: async function* () { yield 42 as never; } }],
      }, limits)),
      { code: 'POLICY_VIOLATION' },
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact input names cannot collide with output duplicate tracking', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'micro-artifact-test-'));
  try {
    const workspace = await prepareWorkspace(root, planArtifacts({
      inputs: [{ target: 'output:result', data: 'input' }],
      outputs: [{ path: 'result' }],
    }, resolveArtifactLimits({}, {}, {})));
    assert.equal(await readFile(path.join(workspace.path, 'input/output:result'), 'utf8'), 'input');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
