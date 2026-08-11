import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SandboxError } from '../dist/errors.js';
import { resolveSupervisorBinary } from '../dist/platform/binary.js';
import { SupervisorClient } from '../dist/supervisor/client.js';
import type {
  SupervisorInboundMessage,
  SupervisorOutboundMessage,
  SupervisorTransport,
} from '../dist/supervisor/transport.js';

class FakeTransport implements SupervisorTransport {
  readonly sent: SupervisorOutboundMessage[] = [];
  private messageListeners = new Set<(message: SupervisorInboundMessage) => void>();
  private closeListeners = new Set<(error?: Error) => void>();

  send(message: SupervisorOutboundMessage): void {
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
  const first = client.request<{ value: number }>('health', {});
  const second = client.request<{ value: number }>('health', {});

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

  await assert.rejects(pending, (error: unknown) => error instanceof SandboxError && error.code === 'CANCELLED');
  assert.deepEqual(transport.sent[1], {
    version: 1,
    id: runMessage.id,
    type: 'cancel',
    payload: { requestId: runMessage.id },
  });
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
