import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProfileRegistry } from '../dist/api/profile-registry.js';
import { RuntimeRegistry } from '../dist/api/runtime-registry.js';
import { SandboxError } from '../dist/errors.js';

test('RuntimeRegistry accepts immutable digest-verified runtime definitions', () => {
  const registry = new RuntimeRegistry();
  const runtime = registry.register({
    id: 'python-3',
    rootfs: '/opt/runtimes/python',
    entrypoint: '/usr/bin/python3',
    digest: `sha256:${'a'.repeat(64)}`,
    profile: 'interpreted-code',
  });

  assert.equal(registry.get('python-3'), runtime);
  assert.equal(Object.isFrozen(runtime), true);
  assert.throws(
    () => registry.register({ ...runtime, id: 'bad id' }),
    (error: unknown) => error instanceof SandboxError && error.code === 'POLICY_VIOLATION',
  );
});

test('RuntimeRegistry rejects duplicate IDs and invalid digests', () => {
  const registry = new RuntimeRegistry();
  const definition = {
    id: 'tool',
    rootfs: '/opt/tool',
    entrypoint: '/bin/tool',
    digest: `sha256:${'b'.repeat(64)}`,
    profile: 'strict',
  };
  registry.register(definition);

  assert.throws(() => registry.register(definition), SandboxError);
  assert.throws(() => registry.register({ ...definition, id: 'other', digest: 'latest' }), SandboxError);
});

test('ProfileRegistry derives a profile without mutating its base', () => {
  const registry = new ProfileRegistry();
  const profile = registry.define('small-build', {
    base: 'compilation',
    limits: { memoryMb: 128, pids: 8 },
    addSyscalls: ['madvise'],
  });

  assert.equal(profile.limits.memoryMb, 128);
  assert.equal(profile.limits.pids, 8);
  assert.equal(profile.addSyscalls.includes('madvise'), true);
  assert.equal(registry.get('compilation').addSyscalls.includes('madvise'), false);
});
