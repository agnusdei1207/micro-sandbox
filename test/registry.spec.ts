import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProfileRegistry } from '../dist/api/profile-registry.js';
import { RuntimeRegistry } from '../dist/api/runtime-registry.js';
import { SandboxError } from '../dist/errors.js';

test('RuntimeRegistry accepts immutable caller-owned runtime definitions', () => {
  const registry = new RuntimeRegistry();
  const runtime = registry.register({
    id: 'python-3',
    rootfs: '/opt/runtimes/python',
    entrypoint: '/usr/bin/python3',
  });

  assert.equal(registry.get('python-3'), runtime);
  assert.equal(Object.isFrozen(runtime), true);
  assert.throws(
    () => registry.register({ ...runtime, id: 'bad id' }),
    (error: unknown) => error instanceof SandboxError && error.code === 'POLICY_VIOLATION',
  );
});

test('RuntimeRegistry rejects duplicate and malformed IDs', () => {
  const registry = new RuntimeRegistry();
  const definition = {
    id: 'tool',
    rootfs: '/opt/tool',
    entrypoint: '/bin/tool',
  };
  registry.register(definition);

  assert.throws(() => registry.register(definition), SandboxError);
  assert.throws(() => registry.register({ ...definition, id: 'bad id' }), SandboxError);
});

test('ProfileRegistry derives a profile without mutating its base', () => {
  const registry = new ProfileRegistry();
  registry.define('base', { limits: { memoryMb: 256, pids: 16 } });
  const profile = registry.define('small-build', {
    extends: 'base',
    limits: { memoryMb: 128, pids: 8 },
  });

  assert.equal(profile.limits.memoryMb, 128);
  assert.equal(profile.limits.pids, 8);
  assert.equal(registry.get('base').limits.memoryMb, 256);
});
