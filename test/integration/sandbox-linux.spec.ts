import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { createSandbox, SandboxError } from '../../dist/index.js';

test('public API executes, threads, cancels, and cleans up isolated jobs', async () => {
  const binary = process.env.MICRO_SANDBOX_BINARY;
  const cgroupRoot = process.env.MICRO_SANDBOX_CGROUP_ROOT;
  assert.ok(binary);
  assert.ok(cgroupRoot);

  const sandbox = await createSandbox({ supervisorBinary: binary, cgroupRoot });
  sandbox.registerRuntime({ id: 'system', rootfs: '/', entrypoint: '/bin/sh' });
  try {
    const result = await sandbox.run({
      runtime: 'system',
      args: ['-c', 'printf public-api; test ! -e /etc/hostname'],
      limits: { memoryMb: 64, pids: 8 },
    });
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), 'public-api');
    assert.equal(result.isolation.pivotRoot, true);

    const threaded = await sandbox.run({
      command: '/usr/local/bin/node',
      args: [
        '-e',
        "const {Worker}=require('node:worker_threads'); const w=new Worker('require(\"node:worker_threads\").parentPort.postMessage(\"thread-ok\")',{eval:true}); w.once('message',console.log)",
      ],
      limits: { memoryMb: 64, pids: 8 },
    });
    assert.equal(threaded.exitCode, 0, threaded.stderr.toString());
    assert.equal(threaded.stdout.toString().trim(), 'thread-ok');

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

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) => sandbox.run({
        runtime: 'system',
        args: ['-c', `printf ${index}`],
        limits: { memoryMb: 32, cpu: 0.1, pids: 4 },
      })),
    );
    assert.deepEqual(
      concurrent.map((item) => item.stdout.toString()),
      Array.from({ length: 8 }, (_, index) => String(index)),
    );
    const remaining = (await readdir(cgroupRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
    assert.deepEqual(remaining, [], 'all job cgroups must be removed');
  } finally {
    await sandbox.close();
  }
});
