import { policyError, protocolError } from '../errors.js';

export const PROTOCOL_VERSION = 1 as const;
export const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;

/**
 * Encodes one outbound frame. An oversized outbound frame is caused by the caller's
 * request (arguments, environment, stdin), so it is a POLICY_VIOLATION rather than a
 * PROTOCOL_ERROR, and it is rejected before anything reaches the supervisor.
 */
export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_CONTROL_FRAME_BYTES) {
    throw policyError('Supervisor control frame is too large', {
      bytes: body.length,
      maximum: MAX_CONTROL_FRAME_BYTES,
    });
  }
  return Buffer.concat([body, Buffer.from('\n')]);
}

/**
 * Splits newline-delimited JSON frames from the supervisor. Partial frames are kept as
 * a chunk list and only newly received bytes are scanned, so decoding is linear in the
 * input size. Malformed or oversized inbound frames are PROTOCOL_ERROR.
 */
export class FrameDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;

  push(input: Uint8Array): unknown[] {
    const chunk = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const messages: unknown[] = [];
    let start = 0;
    let newline = chunk.indexOf(0x0a);
    while (newline !== -1) {
      const tail = chunk.subarray(start, newline);
      const length = this.pendingBytes + tail.length;
      if (length > MAX_CONTROL_FRAME_BYTES) {
        throw protocolError('Supervisor sent an oversized frame');
      }
      const frame = this.pending.length === 0
        ? tail
        : Buffer.concat([...this.pending, tail], length);
      this.pending = [];
      this.pendingBytes = 0;
      if (frame.length > 0) {
        try {
          messages.push(JSON.parse(frame.toString('utf8')) as unknown);
        } catch (cause) {
          throw protocolError('Supervisor sent malformed JSON', undefined, cause);
        }
      }
      start = newline + 1;
      newline = chunk.indexOf(0x0a, start);
    }
    if (start < chunk.length) {
      this.pendingBytes += chunk.length - start;
      if (this.pendingBytes > MAX_CONTROL_FRAME_BYTES) {
        throw protocolError('Supervisor sent an oversized unterminated frame');
      }
      // Copy the fragment so the decoder never aliases a caller-owned buffer.
      this.pending.push(Buffer.from(chunk.subarray(start)));
    }
    return messages;
  }
}
