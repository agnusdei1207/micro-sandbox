import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SandboxError } from '../dist/errors.js';
import { resolveSupervisorBinary } from '../dist/platform/binary.js';
import { SupervisorClient } from '../dist/supervisor/client.js';
import type {
  SupervisorInboundMessage,
  SupervisorRequestMessage,
  SupervisorTransport,
} from '../dist/supervisor/transport.js';
import { validateInboundMessage } from '../dist/supervisor/transport.js';

test('transport validates native response schemas and stable error codes', () => {
  assert.throws(
    () => validateInboundMessage({ version: 1, id: 1, ok: false, error: { code: 'MADE_UP', message: 'x' } }),
    (error: unknown) => error instanceof SandboxError && error.code === 'PROTOCOL_ERROR',
  );
  assert.deepEqual(
    validateInboundMessage({ version: 1, id: 1, ok: false, error: { code: 'CGROUP_ERROR', message: 'x' } }),
    { version: 1, id: 1, ok: false, error: { code: 'CGROUP_ERROR', message: 'x' } },
  );
});

class FakeTransport implements SupervisorTransport {
  readonly sent: SupervisorRequestMessage[] = [];
  private messageListeners = new Set<(message: SupervisorInboundMessage) => void>();
  private closeListeners = new Set<(error?: Error) => void>();

  send(message: SupervisorRequestMessage): void {
    this.sent.push(message);
  }

  onMessage(listener: (message: SupervisorInboundMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  respond(message: SupervisorInboundMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }

  fail(error = new Error('closed')): void {
    for (const listener of this.closeListeners) listener(error);
  }

  async close(): Promise<void> {
    this.fail();
  }
}

test('SupervisorClient correlates concurrent out-of-order responses', async () => {
  const transport = new FakeTransport();
  const client = new SupervisorClient(transport);
  const first = client.request('health', {});
  const second = client.request('health', {});

  const [firstMessage, secondMessage] = transport.sent;
  transport.respond({ version: 1, id: secondMessage.id, ok: true, result: { value: 2 } });
  transport.respond({ version: 1, id: firstMessage.id, ok: true, result: { value: 1 } });

  assert.deepEqual(await first, { value: 1 });
  assert.deepEqual(await second, { value: 2 });
});

test('SupervisorClient maps a remote stable error', async () => {
  const transport = new FakeTransport();
  const client = new SupervisorClient(transport);
  const pending = client.request('run', {});
  const [{ id }] = transport.sent;

  transport.respond({
    version: 1,
    id,
    ok: false,
    error: { code: 'CAPACITY_EXCEEDED', message: 'busy', details: { queued: 10 } },
  });

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof SandboxError &&
      error.code === 'CAPACITY_EXCEEDED' &&
      error.details?.queued === 10,
  );
});

test('SupervisorClient rejects every pending request when transport crashes', async () => {
  const transport = new FakeTransport();
  const client = new SupervisorClient(transport);
  const first = client.request('health', {});
  const second = client.request('health', {});

  transport.fail(new Error('boom'));

  await assert.rejects(first, (error: unknown) => error instanceof SandboxError && error.code === 'SUPERVISOR_UNAVAILABLE');
  await assert.rejects(second, (error: unknown) => error instanceof SandboxError && error.code === 'SUPERVISOR_UNAVAILABLE');
});

test('SupervisorClient sends cancellation and rejects an aborted request', async () => {
  const transport = new FakeTransport();
  const client = new SupervisorClient(transport);
  const controller = new AbortController();
  const pending = client.request('run', {}, controller.signal);
  const runMessage = transport.sent[0];

  controller.abort();
  const cancel = transport.sent[1];
  assert.notEqual(cancel.id, runMessage.id, 'cancel must not reuse the run request id');
  assert.deepEqual(cancel, {
    version: 1,
    id: cancel.id,
    type: 'cancel',
    payload: { requestId: runMessage.id },
  });
  let settled = false;
  void pending.catch(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'cleanup acknowledgement must retain the request slot');
  transport.respond({
    version: 1,
    id: runMessage.id,
    ok: false,
    error: { code: 'CANCELLED', message: 'cancelled' },
  });
  await assert.rejects(pending, (error: unknown) => error instanceof SandboxError && error.code === 'CANCELLED');
});

test('resolveSupervisorBinary rejects unsupported platforms and accepts an explicit override', () => {
  assert.throws(
    () => resolveSupervisorBinary({ platform: 'win32', arch: 'x64', override: undefined }),
    (error: unknown) =>
      error instanceof SandboxError && error.code === 'UNSUPPORTED_PLATFORM',
  );
  assert.equal(
    resolveSupervisorBinary({ platform: 'linux', arch: 'arm64', override: '/safe/micro-sandbox' }),
    '/safe/micro-sandbox',
  );
});

test('SupervisorClient closes the transport after failure and concurrent close calls wait', async () => {
  const transport = new FakeTransport();
  let release!: () => void;
  let closeCalls = 0;
  transport.close = () => {
    closeCalls += 1;
    return new Promise<void>((resolve) => { release = resolve; });
  };
  const client = new SupervisorClient(transport);
  transport.fail();
  let completed = 0;
  const first = client.close().then(() => { completed += 1; });
  const second = client.close().then(() => { completed += 1; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeCalls, 1, 'a failed client still owns its transport');
  assert.equal(completed, 0, 'every close caller must wait for transport cleanup');
  release();
  await Promise.all([first, second]);
  assert.equal(completed, 2);
});

test('SupervisorClient retains cancelled jobs until cleanup when cancellation cannot be sent', async () => {
  const transport = new FakeTransport();
  let release!: () => void;
  let closes = 0;
  transport.close = () => {
    closes += 1;
    return new Promise<void>((resolve) => { release = resolve; });
  };
  const client = new SupervisorClient(transport);
  const controller = new AbortController();
  const pending = client.request('run', {}, controller.signal);
  const checked = assert.rejects(pending, { code: 'SUPERVISOR_UNAVAILABLE' });
  let settled = false;
  void pending.catch(() => { settled = true; });
  transport.send = () => { throw new SandboxError('CAPACITY_EXCEEDED', 'write queue full'); };
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1, 'an undeliverable cancellation must terminate the supervisor');
  assert.equal(settled, false, 'workspace ownership must remain until cleanup completes');
  release();
  await checked;
});

test('SupervisorClient retires the transport when a cancelled request is never acknowledged', async () => {
  const transport = new FakeTransport();
  let closes = 0;
  transport.close = async () => {
    closes += 1;
    transport.fail();
  };
  const client = new SupervisorClient(transport, { cancelGraceMs: 20 });
  const controller = new AbortController();
  const pending = client.request('run', {}, controller.signal);
  controller.abort();
  assert.equal(transport.sent[1]?.type, 'cancel');
  await assert.rejects(pending, { code: 'SUPERVISOR_UNAVAILABLE' });
  assert.equal(closes, 1);
});

test('SupervisorClient keeps the transport when cancellation is acknowledged in time', async () => {
  const transport = new FakeTransport();
  let closes = 0;
  transport.close = async () => { closes += 1; };
  const client = new SupervisorClient(transport, { cancelGraceMs: 20 });
  const controller = new AbortController();
  const pending = client.request('run', {}, controller.signal);
  const runId = transport.sent[0]!.id;
  controller.abort();
  transport.respond({
    version: 1, id: runId, ok: false, error: { code: 'CANCELLED', message: 'cancelled' },
  });
  await assert.rejects(pending, { code: 'CANCELLED' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closes, 0);
});

test('transport validation rejects uncorrelated event frames', () => {
  assert.throws(
    () => validateInboundMessage({ version: 1, event: 'heartbeat', timestampMs: 1 }),
    { code: 'PROTOCOL_ERROR' },
  );
});
