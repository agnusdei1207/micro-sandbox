import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { SandboxError } from '../dist/errors.js';
import { connectSupervisor, SupervisorClient } from '../dist/supervisor/client.js';
import {
  ChildProcessTransport,
  type ChildProcessTransportOptions,
  type SupervisorInboundMessage,
} from '../dist/supervisor/transport.js';

// A stand-in for the native supervisor: newline-delimited JSON on stdin/stdout.
const FAKE_SUPERVISOR = String.raw`
const { writeSync } = require('node:fs');
const mode = process.env.FAKE_MODE;
const reply = (id, result) => writeSync(1, JSON.stringify({ version: 1, id, ok: true, result }) + '\n');
let buffered = '';
function onData(chunk) {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf('\n')) !== -1) {
    const request = JSON.parse(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    if (mode === 'final-then-exit') {
      reply(request.id, 'last words');
      writeSync(2, 'fatal: supervisor gave up\n');
      process.exit(3);
    }
    if (mode !== 'silent') reply(request.id, { type: request.type, bytes: JSON.stringify(request.payload).length });
  }
}
if (mode === 'stubborn') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
function listen() {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  if (mode !== 'stubborn') process.stdin.on('end', () => process.exit(0));
}
// Touching process.stdin starts reading, so 'delayed' leaves it alone until later to
// let the parent's pipe fill up and exercise backpressure.
if (mode === 'delayed') setTimeout(listen, 300);
else listen();
`;

let directory = '';
let script = '';

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'micro-sandbox-transport-'));
  script = path.join(directory, 'fake-supervisor.cjs');
  await writeFile(script, FAKE_SUPERVISOR);
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fake(mode: string, options: ChildProcessTransportOptions = {}): ChildProcessTransport {
  return new ChildProcessTransport(process.execPath, { FAKE_MODE: mode }, { args: [script], ...options });
}

test('transport round-trips frames and closes gracefully on stdin EOF', async () => {
  const client = new SupervisorClient(fake('echo'));
  assert.deepEqual(await client.request('health', {}), { type: 'health', bytes: 2 });
  await client.close();
});

test('transport delivers the final response and stderr even when exit precedes stdio close', async () => {
  const transport = fake('final-then-exit');
  const messages: SupervisorInboundMessage[] = [];
  transport.onMessage((message) => messages.push(message));
  const closed = new Promise<Error | undefined>((resolve) => transport.onClose(resolve));
  transport.send({ version: 1, id: 1, type: 'run', payload: {} });
  const error = await closed;
  assert.deepEqual(messages, [{ version: 1, id: 1, ok: true, result: 'last words' }]);
  assert.ok(error instanceof SandboxError);
  assert.equal(error.code, 'SUPERVISOR_UNAVAILABLE');
  assert.equal(error.details?.code, 3);
  assert.match(String(error.details?.stderr), /fatal: supervisor gave up/);
  await transport.close();
});

test('transport queues writes under backpressure and flushes them on drain', async () => {
  const client = new SupervisorClient(fake('delayed'));
  const payload = { blob: 'x'.repeat(256 * 1024) };
  const results = await Promise.all(
    Array.from({ length: 16 }, () => client.request('run', payload)),
  );
  assert.equal(results.length, 16);
  for (const result of results) {
    assert.deepEqual(result, { type: 'run', bytes: JSON.stringify(payload).length });
  }
  await client.close();
});

test('transport bounds its outbound queue', async () => {
  const transport = fake('delayed', { maxQueuedBytes: 512 * 1024 });
  const frame = { version: 1 as const, id: 1, type: 'run', payload: { blob: 'x'.repeat(200 * 1024) } };
  assert.throws(() => {
    for (let id = 1; id <= 8; id += 1) transport.send({ ...frame, id });
  }, { code: 'CAPACITY_EXCEEDED' });
  await transport.close();
});

test('transport escalates to signals when the supervisor ignores EOF and SIGTERM', async () => {
  const transport = fake('stubborn', { closeGraceMs: 50, terminateGraceMs: 50 });
  const closed = new Promise<Error | undefined>((resolve) => transport.onClose(resolve));
  const started = Date.now();
  await transport.close();
  assert.ok(Date.now() - started < 5_000);
  const error = await closed;
  assert.ok(error instanceof SandboxError);
  if (process.platform !== 'win32') assert.equal(error.details?.signal, 'SIGKILL');
});

test('transport reports a missing supervisor binary as SUPERVISOR_UNAVAILABLE', async () => {
  const transport = new ChildProcessTransport(path.join(directory, 'missing-binary'));
  await assert.rejects(
    connectSupervisor(transport, { startupTimeoutMs: 5_000 }),
    (error: unknown) => error instanceof SandboxError && error.code === 'SUPERVISOR_UNAVAILABLE',
  );
  await transport.close();
});

test('connectSupervisor closes a supervisor that never answers its health check', async () => {
  const transport = fake('silent', { closeGraceMs: 50, terminateGraceMs: 50 });
  await assert.rejects(
    connectSupervisor(transport, { startupTimeoutMs: 100 }),
    (error: unknown) => error instanceof SandboxError
      && error.code === 'SUPERVISOR_UNAVAILABLE'
      && /healthy/.test(error.message),
  );
  assert.throws(
    () => transport.send({ version: 1, id: 9, type: 'health', payload: {} }),
    { code: 'SUPERVISOR_UNAVAILABLE' },
  );
});
