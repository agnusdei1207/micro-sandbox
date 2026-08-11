import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SandboxError } from '../dist/errors.js';
import {
  FrameDecoder,
  MAX_CONTROL_FRAME_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
} from '../dist/supervisor/protocol.js';

test('encodeFrame produces one versioned newline-delimited JSON frame', () => {
  const frame = encodeFrame({ version: PROTOCOL_VERSION, id: 7, type: 'health' });

  assert.equal(frame.at(-1), 0x0a);
  assert.deepEqual(JSON.parse(frame.subarray(0, -1).toString('utf8')), {
    version: 1,
    id: 7,
    type: 'health',
  });
});

test('encodeFrame rejects a control message larger than the protocol bound', () => {
  assert.throws(
    () => encodeFrame({ payload: 'x'.repeat(MAX_CONTROL_FRAME_BYTES) }),
    (error: unknown) =>
      error instanceof SandboxError && error.code === 'POLICY_VIOLATION',
  );
});

test('FrameDecoder reconstructs split and coalesced frames', () => {
  const decoder = new FrameDecoder();
  const first = encodeFrame({ version: 1, id: 1, ok: true });
  const second = encodeFrame({ version: 1, id: 2, ok: false });

  assert.deepEqual(decoder.push(first.subarray(0, 4)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(4), second])), [
    { version: 1, id: 1, ok: true },
    { version: 1, id: 2, ok: false },
  ]);
});

test('FrameDecoder rejects malformed JSON and oversized unterminated input', () => {
  const malformed = new FrameDecoder();
  assert.throws(
    () => malformed.push(Buffer.from('{bad}\n')),
    (error: unknown) =>
      error instanceof SandboxError && error.code === 'SUPERVISOR_UNAVAILABLE',
  );

  const oversized = new FrameDecoder();
  assert.throws(
    () => oversized.push(Buffer.alloc(MAX_CONTROL_FRAME_BYTES + 1, 0x78)),
    (error: unknown) =>
      error instanceof SandboxError && error.code === 'SUPERVISOR_UNAVAILABLE',
  );
});
