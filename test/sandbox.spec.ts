import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sandbox } from '../dist/api/sandbox.js';
import { SandboxError } from '../dist/errors.js';
import type { JobResult, SupervisorRequester } from '../dist/types.js';

function successfulResult(stdout = ''): JobResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    oomKilled: false,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    isolation: {
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
    },
    metrics: { durationMs: 1, peakMemoryBytes: 0 },
  };
}

class ControlledRequester implements SupervisorRequester {
  readonly calls: Array<{ type: string; payload: unknown; signal?: AbortSignal }> = [];
  readonly completions: Array<(result: unknown) => void> = [];
  closed = false;

  request<T>(type: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    this.calls.push({ type, payload, signal });
    return new Promise<T>((resolve, reject) => {
      this.completions.push(resolve as (result: unknown) => void);
      signal?.addEventListener(
        'abort',
        () => reject(new SandboxError('CANCELLED', 'cancelled')),
        { once: true },
      );
    });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

test('Sandbox starts its supervisor lazily and decodes a run result', async () => {
  const requester = new ControlledRequester();
  let starts = 0;
  const sandbox = new Sandbox({}, async () => {
    starts += 1;
    return requester;
  });

  assert.equal(starts, 0);
  const pending = sandbox.run({ command: '/app/echo', args: ['hello'] });
  assert.equal(starts, 1);
  await new Promise((resolve) => setImmediate(resolve));
  requester.completions[0](wireResult('hello'));

  assert.equal((await pending).stdout.toString('utf8'), 'hello');
  assert.equal(requester.calls[0].type, 'run');
  const { jobId, ...payload } = requester.calls[0].payload as { jobId: string };
  assert.match(jobId, /^job-[a-f0-9]{32}$/);
  assert.deepEqual(payload, {
    rootfs: '/',
    command: '/app/echo',
    args: ['hello'],
    cwd: '/',
    env: {},
    stdinBase64: '',
    limits: {
      timeoutMs: 5_000,
      memoryMb: 256,
      cpu: 0.5,
      pids: 16,
      inputBytes: 64 * 1024,
      outputBytes: 256 * 1024,
    },
  });
  await sandbox.close();
});

test('Sandbox admits queued jobs in FIFO order', async () => {
  const requester = new ControlledRequester();
  const sandbox = new Sandbox(
    { capacity: { maxInFlight: 1, maxQueue: 2, overload: 'wait' } },
    async () => requester,
  );

  const first = sandbox.run({ command: '/app/task', args: ['1'] });
  const second = sandbox.run({ command: '/app/task', args: ['2'] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requester.calls.length, 1);

  requester.completions[0](wireResult('1'));
  assert.equal((await first).stdout.toString(), '1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requester.calls.length, 2);
  assert.deepEqual((requester.calls[1].payload as { args: string[] }).args, ['2']);
  requester.completions[1](wireResult('2'));
  await second;
  await sandbox.close();
});

test('Sandbox rejects overload beyond the bounded queue', async () => {
  const requester = new ControlledRequester();
  const sandbox = new Sandbox(
    { capacity: { maxInFlight: 1, maxQueue: 1, overload: 'reject' } },
    async () => requester,
  );

  const first = sandbox.run({ command: '/app/task' });
  await assert.rejects(
    sandbox.run({ command: '/app/task' }),
    (error: unknown) => error instanceof SandboxError && error.code === 'CAPACITY_EXCEEDED',
  );
  requester.completions[0](wireResult());
  await first;
  await sandbox.close();
});

test('Sandbox removes an aborted queued request without starting it', async () => {
  const requester = new ControlledRequester();
  const sandbox = new Sandbox(
    { capacity: { maxInFlight: 1, maxQueue: 2, overload: 'wait' } },
    async () => requester,
  );
  const first = sandbox.run({ command: '/app/task' });
  const controller = new AbortController();
  const queued = sandbox.run({ command: '/app/task', signal: controller.signal });
  controller.abort();
  await assert.rejects(
    queued,
    (error: unknown) => error instanceof SandboxError && error.code === 'CANCELLED',
  );
  requester.completions[0](wireResult());
  await first;
  assert.equal(requester.calls.length, 1);
  await sandbox.close();
});

test('Sandbox rejects new jobs after close starts and drains active work', async () => {
  const requester = new ControlledRequester();
  const sandbox = new Sandbox({}, async () => requester);
  const active = sandbox.run({ command: '/app/task' });
  const closing = sandbox.close();

  await assert.rejects(
    sandbox.run({ command: '/app/task' }),
    (error: unknown) => error instanceof SandboxError && error.code === 'SUPERVISOR_UNAVAILABLE',
  );
  assert.equal(requester.closed, false);
  requester.completions[0](wireResult());
  await active;
  await closing;
  assert.equal(requester.closed, true);
});

test('Sandbox resolves caller-owned runtimes, profiles, environment, and stdin', async () => {
  const requester = new ControlledRequester();
  const sandbox = new Sandbox({}, async () => requester);
  sandbox.registerRuntime({
    id: 'python',
    rootfs: '/opt/python-root',
    entrypoint: '/usr/bin/python3',
  });
  sandbox.defineProfile('small', { limits: { memoryMb: 64, pids: 4 } });

  const pending = sandbox.run({
    runtime: 'python',
    profile: 'small',
    args: ['-c', 'print(input())'],
    cwd: '/tmp',
    env: { MODE: 'safe' },
    stdin: 'hello\n',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const payload = requester.calls[0].payload as Record<string, unknown>;
  assert.equal(payload.rootfs, '/opt/python-root');
  assert.equal(payload.command, '/usr/bin/python3');
  assert.equal(payload.cwd, '/tmp');
  assert.deepEqual(payload.env, { MODE: 'safe' });
  assert.equal(payload.stdinBase64, Buffer.from('hello\n').toString('base64'));
  assert.equal((payload.limits as { memoryMb: number }).memoryMb, 64);
  requester.completions[0](wireResult('hello\n'));
  await pending;
  await sandbox.close();
});

function wireResult(stdout = ''): Record<string, unknown> {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimitExceeded: false,
    oomKilled: false,
    stdoutBase64: Buffer.from(stdout).toString('base64'),
    stderrBase64: '',
    isolation: successfulResult().isolation,
    metrics: { durationMs: 1, peakMemoryBytes: 0 },
  };
}

test('Sandbox close waits for the supervisor transport to finish closing', async () => {
  let releaseClose!: () => void;
  const requester: SupervisorRequester = {
    request: async () => wireResult(),
    close: () => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }),
  };
  const sandbox = new Sandbox({}, async () => requester);
  await sandbox.run({ command: '/app/task' });

  let closed = false;
  const closing = sandbox.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  releaseClose();
  await closing;
  assert.equal(closed, true);
});

test('Sandbox close rejects instead of hanging when supervisor startup failed', async () => {
  const startupError = new Error('cannot start');
  const sandbox = new Sandbox({}, async () => Promise.reject(startupError));

  await assert.rejects(sandbox.run({ command: '/bin/true' }), startupError);
  await assert.rejects(sandbox.close(), startupError);
});

test('Sandbox restarts a crashed supervisor for the next request', async () => {
  let starts = 0;
  const healthy = new ControlledRequester();
  const sandbox = new Sandbox({}, async () => {
    starts += 1;
    if (starts === 1) {
      return {
        request: async () => { throw new SandboxError('SUPERVISOR_UNAVAILABLE', 'crashed'); },
        close: async () => {},
      };
    }
    return healthy;
  });

  await assert.rejects(
    sandbox.run({ command: '/bin/true' }),
    (error: unknown) => error instanceof SandboxError && error.code === 'SUPERVISOR_UNAVAILABLE',
  );
  const recovered = sandbox.run({ command: '/bin/true' });
  await new Promise((resolve) => setImmediate(resolve));
  healthy.completions[0](wireResult('ok'));
  assert.equal((await recovered).stdout.toString(), 'ok');
  assert.equal(starts, 2);
  await sandbox.close();
});
