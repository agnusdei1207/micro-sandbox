import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SandboxError } from '../dist/errors.js';
import { resolveSupervisorEnvironment } from '../dist/platform/environment.js';

test('cgroup delegation is explicit and can be configured without global environment mutation', () => {
  assert.deepEqual(
    resolveSupervisorEnvironment({ cgroupRoot: '/sys/fs/cgroup/apps/sandbox' }, {}),
    { MICRO_SANDBOX_CGROUP_ROOT: '/sys/fs/cgroup/apps/sandbox' },
  );
  assert.throws(
    () => resolveSupervisorEnvironment({}, {}),
    (error: unknown) =>
      error instanceof SandboxError && error.code === 'CGROUP_DELEGATION_REQUIRED',
  );
});
