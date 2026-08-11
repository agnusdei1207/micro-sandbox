import { SandboxError } from '../errors.js';

export const PROTOCOL_VERSION = 1 as const;
export const MAX_CONTROL_FRAME_BYTES = 1024 * 1024;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_CONTROL_FRAME_BYTES) {
    throw new SandboxError('POLICY_VIOLATION', 'Supervisor control frame is too large', {
      bytes: body.length,
      maximum: MAX_CONTROL_FRAME_BYTES,
    });
  }
  return Buffer.concat([body, Buffer.from('\n')]);
}

export class FrameDecoder {
  private buffered = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length > MAX_CONTROL_FRAME_BYTES && !this.buffered.includes(0x0a)) {
      throw protocolError('Supervisor sent an oversized unterminated frame');
    }

    const messages: unknown[] = [];
    let newline = this.buffered.indexOf(0x0a);
    while (newline !== -1) {
      const frame = this.buffered.subarray(0, newline);
      this.buffered = this.buffered.subarray(newline + 1);
      if (frame.length > MAX_CONTROL_FRAME_BYTES) {
        throw protocolError('Supervisor sent an oversized frame');
      }
      if (frame.length > 0) {
        try {
          messages.push(JSON.parse(frame.toString('utf8')) as unknown);
        } catch (cause) {
          throw protocolError('Supervisor sent malformed JSON', cause);
        }
      }
      newline = this.buffered.indexOf(0x0a);
    }
    return messages;
  }
}

function protocolError(message: string, cause?: unknown): SandboxError {
  return new SandboxError('SUPERVISOR_UNAVAILABLE', message, undefined, {
    cause,
  });
}
