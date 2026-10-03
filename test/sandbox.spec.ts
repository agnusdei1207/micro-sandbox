import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
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
    artifacts: [],
  };
}

class ControlledRequester implements SupervisorRequester {
  readonly calls: Array<{ type: string; payload: unknown; signal?: AbortSignal }> = [];
  readonly completions: Array<(result: unknown) => void> = [];
  closed = false;

  request(type: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ type, payload, signal });
    return new Promise<unknown>((resolve, reject) => {
      this.completions.push(resolve);
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

test('Sandbox stages buffer and stream artifacts without putting bytes in the control frame', async () => {
  const requester = new ControlledRequester();
  const sandbox = new Sandbox({}, async () => requester);
  const pending = sandbox.run({
    command: '/bin/sh',
    args: ['-c', 'cat /input/a.bin /input/nested/b.bin > /output/result.bin'],
    artifacts: {
      inputs: [
        { target: 'a.bin', data: Buffer.alloc(5 * 1024 * 1024, 0x61) },
        { target: 'nested/b.bin', stream: Readable.from(Buffer.from('tail')) },
      ],
      outputs: [{ path: 'result.bin' }],
      limits: { inputBytes: 8 * 1024 * 1024, outputBytes: 8 * 1024 * 1024 },
    },
  });
  while (requester.calls.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const payload = requester.calls[0].payload as Record<string, unknown>;
  assert.equal(JSON.stringify(payload).includes(Buffer.alloc(1024, 0x61).toString('base64')), false);
  const workspace = payload.workspace as { path: string };
  assert.ok(workspace.path);
  await writeFile(`${workspace.path}/output/result.bin`, 'tail');
  const sha256 = createHash('sha256').update('tail').digest('hex');
  requester.completions[0]({
    ...wireResult(),
    artifacts: [{ path: 'result.bin', size: 4, sha256 }],
  });

  const result = await pending;
  assert.deepEqual(result.artifacts, [{
    path: 'result.bin', size: 4, sha256, data: Buffer.from('tail'),
  }]);
  await sandbox.close();
});

test('Sandbox cancels blocked artifact streams and removes their workspace', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-test-'));
  const requester = new ControlledRequester();
  const sandbox = new Sandbox({ workspaceRoot }, async () => requester);
  const controller = new AbortController();
  const stream = Readable.from((async function* () {
    yield Buffer.from('started');
    await new Promise(() => undefined);
  })());
  const pending = sandbox.run({
    command: '/bin/true',
    signal: controller.signal,
    artifacts: {
      inputs: [{ target: 'upload.bin', stream }],
      outputs: [{ path: 'result.bin' }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error: unknown) => (
    error instanceof SandboxError && error.code === 'CANCELLED'
  ));
  assert.deepEqual(await readdir(workspaceRoot), []);
  assert.equal(requester.calls.length, 0);
  await sandbox.close();
});

test('Sandbox rejects artifact targets that do not name a file', async () => {
  const sandbox = new Sandbox({}, async () => new ControlledRequester());
  await assert.rejects(
    sandbox.run({
      command: '/bin/true',
      artifacts: {
        inputs: [{ target: '.', data: 'invalid' }],
        outputs: [{ path: 'result.bin' }],
      },
    }),
    (error: unknown) => error instanceof SandboxError && error.code === 'POLICY_VIOLATION',
  );
  await sandbox.close();
});

test('Sandbox accepts five upload inputs with 5 MiB per-file and 8 MiB aggregate limits', async () => {
  const requester = new ControlledRequester();
  const sandbox = new Sandbox({}, async () => requester);
  const mib = 1024 * 1024;
  const pending = sandbox.run({
    command: '/bin/true',
    artifacts: {
      inputs: [5, 1, 1, 0.5, 0.5].map((size, index) => ({
        target: `upload-${index}.bin`,
        data: Buffer.alloc(size * mib),
      })),
      limits: { inputFiles: 5, inputBytes: 8 * mib, inputFileBytes: 5 * mib },
    },
  });
  while (requester.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  requester.completions[0](wireResult());
  assert.deepEqual((await pending).artifacts, []);
  await sandbox.close();
});

test('Sandbox rejects malformed native job results before exposing them', async () => {
  const requester: SupervisorRequester = {
    request: async () => ({ ...wireResult(), stdoutBase64: 'not-base64!' }),
    close: async () => undefined,
  };
  const sandbox = new Sandbox({}, async () => requester);
  await assert.rejects(
    sandbox.run({ command: '/bin/true' }),
    (error: unknown) => error instanceof SandboxError && error.code === 'PROTOCOL_ERROR',
  );
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

test('Sandbox close resolves instead of hanging or rethrowing when supervisor startup failed', async () => {
  // The startup error belongs to the run that triggered it; close() has nothing to release.
  const startupError = new Error('cannot start');
  const sandbox = new Sandbox({}, async () => Promise.reject(startupError));

  await assert.rejects(sandbox.run({ command: '/bin/true' }), startupError);
  await sandbox.close();
});

test('Sandbox retries supervisor startup after any startup failure', async () => {
  let starts = 0;
  const healthy = new ControlledRequester();
  const sandbox = new Sandbox({}, async () => {
    starts += 1;
    if (starts === 1) throw new SandboxError('CGROUP_DELEGATION_REQUIRED', 'not delegated');
    return healthy;
  });
  await assert.rejects(sandbox.run({ command: '/bin/true' }), { code: 'CGROUP_DELEGATION_REQUIRED' });
  const recovered = sandbox.run({ command: '/bin/true' });
  while (healthy.completions.length === 0) await new Promise((resolve) => setImmediate(resolve));
  healthy.completions[0](wireResult('ok'));
  assert.equal((await recovered).stdout.toString(), 'ok');
  assert.equal(starts, 2);
  await sandbox.close();
  assert.equal(healthy.closed, true);
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

test('Sandbox waits for failed supervisor cleanup before releasing its job', async () => {
  let release!: () => void;
  let closeCalls = 0;
  const sandbox = new Sandbox({}, async () => ({
    request: async () => { throw new SandboxError('SUPERVISOR_UNAVAILABLE', 'pipe failed'); },
    close: () => {
      closeCalls += 1;
      return new Promise<void>((resolve) => { release = resolve; });
    },
  }));
  let settled = false;
  const pending = sandbox.run({ command: '/bin/true' });
  const checked = assert.rejects(pending, { code: 'SUPERVISOR_UNAVAILABLE' });
  void pending.catch(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1);
  assert.equal(settled, false);
  release();
  await checked;
  await sandbox.close();
});

test('Sandbox removes its owned workspace root even if supervisor close fails', async () => {
  let workspace = '';
  const closeError = new Error('close failed');
  const sandbox = new Sandbox({}, async () => ({
    request: async (_type, payload) => {
      workspace = (payload as { workspace: { path: string } }).workspace.path;
      return wireResult();
    },
    close: async () => { throw closeError; },
  }));
  await sandbox.run({ command: '/bin/true', artifacts: {} });
  await assert.rejects(sandbox.close(), closeError);
  await assert.rejects(stat(path.dirname(workspace)), { code: 'ENOENT' });
});

test('Sandbox rejects a manifest that omits a required output and cleans the workspace', async () => {
  let workspace = '';
  const sandbox = new Sandbox({}, async () => ({
    request: async (_type, payload) => {
      workspace = (payload as { workspace: { path: string } }).workspace.path;
      return wireResult();
    },
    close: async () => {},
  }));
  try {
    await assert.rejects(sandbox.run({
      command: '/bin/true', artifacts: { outputs: [{ path: 'required.bin' }] },
    }), { code: 'POLICY_VIOLATION' });
    await assert.rejects(stat(workspace), { code: 'ENOENT' });
  } finally {
    await sandbox.close();
  }
});

test('Sandbox registry access cannot bypass the configuration lock', async () => {
  const sandbox = new Sandbox({}, async () => ({
    request: async () => wireResult(), close: async () => {},
  }));
  await sandbox.run({ command: '/bin/true' });
  try {
    assert.throws(() => sandbox.runtimes.register({
      id: 'late', rootfs: '/', entrypoint: '/bin/true',
    }), { code: 'POLICY_VIOLATION' });
    assert.throws(() => sandbox.profiles.define('late', {}), { code: 'POLICY_VIOLATION' });
  } finally {
    await sandbox.close();
  }
});

test('Sandbox validates policy before starting the supervisor or consuming artifact inputs', async () => {
  let starts = 0;
  let consumed = false;
  const sandbox = new Sandbox({}, async () => {
    starts += 1;
    return { request: async () => wireResult(), close: async () => {} };
  });
  try {
    await assert.rejects(sandbox.run({
      command: '/bin/true', limits: { timeoutMs: -1 },
      artifacts: { inputs: [{ target: 'input', iterable: async function* () {
        consumed = true;
        yield 'data';
      } }] },
    }), { code: 'POLICY_VIOLATION' });
    assert.equal(starts, 0);
    assert.equal(consumed, false);
  } finally {
    await sandbox.close();
  }
});

test('Sandbox enforces stdin byte policy before sending a request', async () => {
  let starts = 0;
  const sandbox = new Sandbox({}, async () => {
    starts += 1;
    return { request: async () => wireResult(), close: async () => {} };
  });
  try {
    await assert.rejects(sandbox.run({
      command: '/bin/true', stdin: '한', limits: { inputBytes: 2 },
    }), { code: 'POLICY_VIOLATION' });
    assert.equal(starts, 0);
  } finally {
    await sandbox.close();
  }
});

test('Sandbox decodes stdout at the native 512 KiB ceiling', async () => {
  const output = 'x'.repeat(512 * 1024);
  const sandbox = new Sandbox({}, async () => ({
    request: async () => wireResult(output), close: async () => {},
  }));
  try {
    const result = await sandbox.run({ command: '/bin/true', limits: { outputBytes: 512 * 1024 } });
    assert.equal(result.stdout.toString(), output);
  } finally {
    await sandbox.close();
  }
});

test('Sandbox.run reports invalid requests as a rejected promise, never a synchronous throw', async () => {
  const sandbox = new Sandbox({}, async () => new ControlledRequester());
  try {
    let pending: Promise<unknown> | undefined;
    assert.doesNotThrow(() => { pending = sandbox.run({ command: 'rel' }); });
    await assert.rejects(pending!, { code: 'POLICY_VIOLATION' });
    await assert.rejects(sandbox.run({ command: 'rel' }), { code: 'POLICY_VIOLATION' });
    await assert.rejects(sandbox.run({ command: '/bin/true', cwd: '../x' }), { code: 'POLICY_VIOLATION' });
    await assert.rejects(sandbox.run({ runtime: 'missing' }), { code: 'POLICY_VIOLATION' });
  } finally {
    await sandbox.close();
  }
});

test('Sandbox rejects unknown limit keys before they reach the native schema', async () => {
  let starts = 0;
  const sandbox = new Sandbox({}, async () => {
    starts += 1;
    return new ControlledRequester();
  });
  try {
    await assert.rejects(
      sandbox.run({ command: '/bin/true', limits: { memoryMB: 64 } as never }),
      { code: 'POLICY_VIOLATION' },
    );
    await assert.rejects(
      sandbox.run({ command: '/bin/true', artifacts: { limits: { files: 1 } as never } }),
      { code: 'POLICY_VIOLATION' },
    );
    assert.throws(
      () => sandbox.defineProfile('typo', { limits: { cpus: 1 } as never }),
      { code: 'POLICY_VIOLATION' },
    );
    assert.throws(
      () => sandbox.defineProfile('negative', { limits: { memoryMb: -1 } }),
      { code: 'POLICY_VIOLATION' },
    );
    assert.equal(starts, 0);
  } finally {
    await sandbox.close();
  }
  const misconfigured = new Sandbox({ defaults: { timeout: 1 } as never }, async () => new ControlledRequester());
  await assert.rejects(misconfigured.run({ command: '/bin/true' }), { code: 'POLICY_VIOLATION' });
  await misconfigured.close();
});

test('Sandbox sends only native limit keys on the wire', async () => {
  const requester = new ControlledRequester();
  const sandbox = new Sandbox({}, async () => requester);
  const pending = sandbox.run({ command: '/bin/true', artifacts: {} });
  while (requester.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const payload = requester.calls[0]!.payload as {
    limits: object; workspace: { limits: object };
  };
  assert.deepEqual(Object.keys(payload.limits).sort(), [
    'cpu', 'inputBytes', 'memoryMb', 'outputBytes', 'pids', 'timeoutMs',
  ]);
  assert.deepEqual(Object.keys(payload.workspace.limits).sort(), [
    'inputBytes', 'inputFileBytes', 'inputFiles', 'outputBytes', 'outputFileBytes', 'outputFiles',
  ]);
  requester.completions[0]!(wireResult());
  await pending;
  await sandbox.close();
});

test('Sandbox rejects an invalid overload mode', () => {
  assert.throws(
    () => new Sandbox({ capacity: { overload: 'drop' as never } }),
    { code: 'POLICY_VIOLATION' },
  );
});

test('Sandbox snapshots a request when run() is called', async () => {
  const requester = new ControlledRequester();
  const sandbox = new Sandbox({ capacity: { maxInFlight: 1, maxQueue: 1 } }, async () => requester);
  const first = sandbox.run({ command: '/app/task' });
  const args = ['original'];
  const env: Record<string, string> = { MODE: 'original' };
  const queued = sandbox.run({ command: '/app/task', args, env });
  args[0] = 'mutated\0';
  env.MODE = 'mutated';
  await new Promise((resolve) => setImmediate(resolve));
  requester.completions[0]!(wireResult());
  await first;
  while (requester.calls.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const payload = requester.calls[1]!.payload as { args: string[]; env: Record<string, string> };
  assert.deepEqual(payload.args, ['original']);
  assert.deepEqual(payload.env, { MODE: 'original' });
  requester.completions[1]!(wireResult());
  await queued;
  await sandbox.close();
});

test('Sandbox rejects overlapping artifact paths before staging anything', async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-test-'));
  const sandbox = new Sandbox({ workspaceRoot }, async () => new ControlledRequester());
  try {
    for (const artifacts of [
      { inputs: [{ target: 'a', data: 'x' }, { target: 'a/b', data: 'y' }] },
      { inputs: [{ target: 'a/b', data: 'x' }, { target: 'a', data: 'y' }] },
      { outputs: [{ path: 'out' }, { path: 'out/nested' }] },
    ]) {
      await assert.rejects(
        sandbox.run({ command: '/bin/true', artifacts }),
        { code: 'POLICY_VIOLATION' },
      );
    }
    assert.deepEqual(await readdir(workspaceRoot), []);
  } finally {
    await sandbox.close();
  }
});

test('Sandbox reports a cancelled request as CANCELLED while supervisor startup is pending', async () => {
  let finishStartup!: (requester: SupervisorRequester) => void;
  const requester = new ControlledRequester();
  const sandbox = new Sandbox({}, () => new Promise((resolve) => { finishStartup = resolve; }));
  const controller = new AbortController();
  const pending = sandbox.run({ command: '/bin/true', signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(requester.calls.length, 0);
  finishStartup(requester);
  await sandbox.close();
  assert.equal(requester.closed, true, 'a startup that completes after cancellation is still closed');
});

test('Sandbox reports CANCELLED and replaces a supervisor retired after an unacknowledged cancel', async () => {
  let starts = 0;
  const retired = {
    closed: false,
    request: (_type: string, _payload: unknown, signal?: AbortSignal) => new Promise<unknown>((_resolve, reject) => {
      signal?.addEventListener('abort', () => setTimeout(() => {
        reject(new SandboxError('SUPERVISOR_UNAVAILABLE', 'retired after cancel grace'));
      }, 5), { once: true });
    }),
    close: async () => { retired.closed = true; },
  };
  const sandbox = new Sandbox({}, async () => {
    starts += 1;
    return starts === 1 ? retired : { request: async () => wireResult('fresh'), close: async () => {} };
  });
  const controller = new AbortController();
  const pending = sandbox.run({ command: '/bin/true', signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  assert.equal(retired.closed, true);
  assert.equal((await sandbox.run({ command: '/bin/true' })).stdout.toString(), 'fresh');
  assert.equal(starts, 2);
  await sandbox.close();
});

test('a delayed old supervisor failure cannot discard a healthy replacement', async () => {
  const failures: Array<(error: Error) => void> = [];
  let starts = 0;
  const sandbox = new Sandbox({ capacity: { maxInFlight: 2 } }, async () => {
    starts += 1;
    return starts === 1 ? {
      request: () => new Promise((_resolve, reject) => { failures.push(reject); }),
      close: async () => {},
    } : { request: async () => wireResult('recovered'), close: async () => {} };
  });
  const first = sandbox.run({ command: '/bin/true' });
  const second = sandbox.run({ command: '/bin/true' });
  const firstChecked = assert.rejects(first, { code: 'SUPERVISOR_UNAVAILABLE' });
  const secondChecked = assert.rejects(second, { code: 'SUPERVISOR_UNAVAILABLE' });
  await new Promise((resolve) => setImmediate(resolve));
  failures[0](new SandboxError('SUPERVISOR_UNAVAILABLE', 'old failure'));
  await firstChecked;
  assert.equal((await sandbox.run({ command: '/bin/true' })).stdout.toString(), 'recovered');
  failures[1](new SandboxError('SUPERVISOR_UNAVAILABLE', 'delayed old failure'));
  await secondChecked;
  await sandbox.run({ command: '/bin/true' });
  assert.equal(starts, 2);
  await sandbox.close();
});
