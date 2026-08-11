import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SandboxError } from '../dist/errors.js';
import {
  DEFAULT_CEILINGS,
  DEFAULT_LIMITS,
  resolvePolicy,
} from '../dist/policy/resolve.js';
import { normalizeGuestPath } from '../dist/policy/paths.js';

test('resolvePolicy returns safe immutable defaults', () => {
  const policy = resolvePolicy();

  assert.deepEqual(policy.limits, DEFAULT_LIMITS);
  assert.deepEqual(policy.ceilings, DEFAULT_CEILINGS);
  assert.deepEqual(policy.isolation, {
    userNamespace: true,
    pidNamespace: true,
    mountNamespace: true,
    networkNamespace: true,
    ipcNamespace: true,
    utsNamespace: true,
    cgroupNamespace: true,
    cgroupV2: true,
    seccomp: true,
    noNewPrivileges: true,
    capabilitiesDropped: true,
    pivotRoot: true,
  });
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.limits), true);
  assert.equal(Object.isFrozen(policy.isolation), true);
});

test('resolvePolicy layers instance defaults and per-job limits', () => {
  const policy = resolvePolicy(
    {
      defaults: { memoryMb: 128, timeoutMs: 2_000 },
      ceilings: { memoryMb: 384, timeoutMs: 10_000 },
    },
    { memoryMb: 256, pids: 8 },
  );

  assert.equal(policy.limits.memoryMb, 256);
  assert.equal(policy.limits.timeoutMs, 2_000);
  assert.equal(policy.limits.pids, 8);
  assert.equal(policy.ceilings.memoryMb, 384);
});

test('resolvePolicy rejects a per-job value above the operator ceiling', () => {
  assert.throws(
    () => resolvePolicy({ ceilings: { memoryMb: 256 } }, { memoryMb: 257 }),
    (error: unknown) =>
      error instanceof SandboxError &&
      error.code === 'POLICY_VIOLATION' &&
      error.details?.field === 'memoryMb',
  );
});

test('resolvePolicy rejects invalid numeric limits', () => {
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => resolvePolicy({}, { timeoutMs }),
      (error: unknown) =>
        error instanceof SandboxError && error.code === 'POLICY_VIOLATION',
    );
  }
});

test('normalizeGuestPath accepts a normalized absolute workspace path', () => {
  assert.equal(normalizeGuestPath('/workspace/input/file.txt'), '/workspace/input/file.txt');
});

test('normalizeGuestPath can explicitly allow the guest root for a working directory', () => {
  assert.equal(normalizeGuestPath('/', true), '/');
});

test('normalizeGuestPath rejects traversal, relative, reserved, root, and NUL paths', () => {
  for (const path of [
    '../secret',
    'relative/file',
    '/workspace/../secret',
    '/proc/self/status',
    '/sys/kernel',
    '/dev/mem',
    '/',
    '/workspace/bad\0name',
  ]) {
    assert.throws(
      () => normalizeGuestPath(path),
      (error: unknown) =>
        error instanceof SandboxError && error.code === 'POLICY_VIOLATION',
      path,
    );
  }
});

test('SandboxError preserves a stable code and structured details', () => {
  const error = new SandboxError('CAPACITY_EXCEEDED', 'No capacity', {
    availableMemoryMb: 10,
  });

  assert.equal(error.name, 'SandboxError');
  assert.equal(error.code, 'CAPACITY_EXCEEDED');
  assert.deepEqual(error.details, { availableMemoryMb: 10 });
});
