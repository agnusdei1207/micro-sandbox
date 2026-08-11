import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSandbox, SandboxError } from '../../dist/index.js';

test('public API executes and cancels isolated Linux jobs end to end', async () => {
  const binary = process.env.MICRO_SANDBOX_BINARY;
  const cgroupRoot = process.env.MICRO_SANDBOX_CGROUP_ROOT;
  assert.ok(binary);
  assert.ok(cgroupRoot);

  const sandbox = await createSandbox({ supervisorBinary: binary, cgroupRoot });
  sandbox.registerRuntime({ id: 'system', rootfs: '/', entrypoint: '/bin/sh' });

  const result = await sandbox.run({
    runtime: 'system',
    args: ['-c', 'printf public-api; test ! -e /etc/hostname'],
    limits: { memoryMb: 64, pids: 8 },
  });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  assert.equal(result.stdout.toString(), 'public-api');
  assert.equal(result.isolation.pivotRoot, true);

  const controller = new AbortController();
  const cancelled = sandbox.run({
    runtime: 'system',
    args: ['-c', "trap '' TERM; sleep 30"],
    signal: controller.signal,
    limits: { memoryMb: 64, pids: 8, timeoutMs: 30_000 },
  });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(
    cancelled,
    (error: unknown) => error instanceof SandboxError && error.code === 'CANCELLED',
  );
  await sandbox.close();
});
