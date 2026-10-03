import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  isErrorCode,
  protocolError,
  SandboxError,
  toError,
  type SandboxErrorCode,
} from '../errors.js';
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION } from './protocol.js';

export interface SupervisorRequestMessage {
  readonly version: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly type: string;
  readonly payload: unknown;
}

export type SupervisorInboundMessage =
  | {
      readonly version: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly version: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly ok: false;
      readonly error: {
        readonly code: SandboxErrorCode;
        readonly message: string;
        readonly details?: Readonly<Record<string, unknown>>;
      };
    };

export interface SupervisorTransport {
  send(message: SupervisorRequestMessage): void;
  onMessage(listener: (message: SupervisorInboundMessage) => void): void;
  onClose(listener: (error?: Error) => void): void;
  close(): Promise<void>;
}

/** Internal knobs; defaults suit the native supervisor. */
export interface ChildProcessTransportOptions {
  /** Arguments passed to the binary. */
  readonly args?: readonly string[];
  /**
   * How long close() waits after stdin EOF for the supervisor to cancel, reap, and
   * clean up its jobs before sending SIGTERM.
   */
  readonly closeGraceMs?: number;
  /** How long close() waits after SIGTERM before SIGKILL. */
  readonly terminateGraceMs?: number;
  /** How long to wait for stdio to drain after the process exited before forcing close. */
  readonly drainGraceMs?: number;
  /** Bound on bytes accepted by send() but not yet written to the pipe. */
  readonly maxQueuedBytes?: number;
}

const DEFAULT_CLOSE_GRACE_MS = 5_000;
const DEFAULT_TERMINATE_GRACE_MS = 1_000;
const DEFAULT_DRAIN_GRACE_MS = 1_000;
const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_CHARS = 64 * 1024;

export class ChildProcessTransport implements SupervisorTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly messages = new Set<(message: SupervisorInboundMessage) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  private readonly decoder = new FrameDecoder();
  private readonly closeGraceMs: number;
  private readonly terminateGraceMs: number;
  private readonly drainGraceMs: number;
  private readonly maxQueuedBytes: number;
  private stderr = '';
  private stdinError: Error | undefined;
  private closed = false;
  private processExited = false;
  private finished = false;
  private exitStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  private queuedBytes = 0;
  private backpressured = false;
  private readonly outbound: Buffer[] = [];
  private readonly finishedPromise: Promise<void>;
  private resolveFinished!: () => void;

  constructor(
    binary: string,
    environment: Readonly<Record<string, string>> = {},
    options: ChildProcessTransportOptions = {},
  ) {
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
    this.drainGraceMs = options.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
    this.maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    this.finishedPromise = new Promise<void>((resolve) => { this.resolveFinished = resolve; });
    this.child = spawn(binary, [...(options.args ?? ['supervise'])], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...environment },
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-MAX_STDERR_CHARS);
    });
    this.child.stdin.on('error', (error) => this.handleStdinFailure(error));
    this.child.stdin.on('drain', () => {
      this.backpressured = false;
      this.flushOutbound();
    });
    this.child.once('error', (error) => {
      // A spawn failure is followed by 'close'. Any other child error (a failed kill)
      // leaves lifecycle tracking to 'exit' and 'close'.
      if (this.child.pid !== undefined) return;
      this.handleClose(
        new SandboxError('SUPERVISOR_UNAVAILABLE', 'Sandbox supervisor could not be started', {
          binary,
        }, { cause: error }),
      );
    });
    // 'exit' can precede the final stdout/stderr bytes. Record the status here and
    // finalize on 'close', after stdio has drained, so the last response and any
    // fatal stderr message are not lost.
    this.child.once('exit', (code, signal) => {
      this.processExited = true;
      this.exitStatus = { code, signal };
      const timer = setTimeout(() => {
        // A leaked descendant can hold stdio open; never wait on it indefinitely.
        this.child.stdout.destroy();
        this.child.stderr.destroy();
        this.finish();
      }, this.drainGraceMs);
      timer.unref();
      void this.finishedPromise.then(() => clearTimeout(timer));
    });
    this.child.once('close', () => this.finish());
  }

  send(message: SupervisorRequestMessage): void {
    if (this.closed || this.stdinError || !this.child.stdin.writable) {
      throw new SandboxError('SUPERVISOR_UNAVAILABLE', 'Sandbox supervisor is not writable');
    }
    const frame = encodeFrame(message);
    if (this.queuedBytes + frame.length > this.maxQueuedBytes) {
      throw new SandboxError('CAPACITY_EXCEEDED', 'Supervisor write queue is full');
    }
    this.queuedBytes += frame.length;
    this.outbound.push(frame);
    this.flushOutbound();
  }

  onMessage(listener: (message: SupervisorInboundMessage) => void): void {
    this.messages.add(listener);
  }

  onClose(listener: (error?: Error) => void): void {
    this.closes.add(listener);
  }

  /**
   * Graceful shutdown: stdin EOF lets the native supervisor cancel, reap, and clean up
   * its jobs and cgroups. SIGTERM follows after `closeGraceMs`, SIGKILL after a further
   * `terminateGraceMs`.
   */
  async close(): Promise<void> {
    if (this.finished) return;
    if (!this.processExited && this.child.stdin.writable) this.child.stdin.end();
    let killTimer: NodeJS.Timeout | undefined;
    const termTimer = setTimeout(() => {
      if (this.processExited) return;
      this.child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!this.processExited) this.child.kill('SIGKILL');
      }, this.terminateGraceMs);
      killTimer.unref();
    }, this.closeGraceMs);
    termTimer.unref();
    try {
      await this.finishedPromise;
    } finally {
      clearTimeout(termTimer);
      if (killTimer) clearTimeout(killTimer);
    }
  }

  private handleData(chunk: Buffer): void {
    if (this.closed) return;
    try {
      for (const message of this.decoder.push(chunk)) {
        const validated = validateInboundMessage(message);
        for (const listener of this.messages) {
          listener(validated);
        }
      }
    } catch (error) {
      this.handleClose(toError(error));
      this.child.kill('SIGKILL');
    }
  }

  private flushOutbound(): void {
    while (!this.backpressured && this.outbound.length > 0 && !this.closed) {
      const frame = this.outbound.shift();
      if (!frame) return;
      this.backpressured = !this.child.stdin.write(frame, (error) => {
        this.queuedBytes -= frame.length;
        if (error) this.handleStdinFailure(error);
      });
    }
  }

  /**
   * A broken stdin pipe means the supervisor stopped reading and is shutting down.
   * Stop writing, but finalize only on 'close' so its final responses still arrive.
   */
  private handleStdinFailure(error: Error): void {
    this.stdinError ??= error;
    this.outbound.length = 0;
    this.backpressured = true;
    void this.close();
  }

  private handleClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener(error);
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.handleClose(
      new SandboxError('SUPERVISOR_UNAVAILABLE', 'Sandbox supervisor exited', {
        code: this.exitStatus?.code ?? null,
        signal: this.exitStatus?.signal ?? null,
        stderr: this.stderr,
      }, this.stdinError ? { cause: this.stdinError } : undefined),
    );
    this.resolveFinished();
  }
}

export function validateInboundMessage(value: unknown): SupervisorInboundMessage {
  if (!value || typeof value !== 'object') throw protocolError('message must be an object');
  const message = value as Record<string, unknown>;
  if (message.version !== PROTOCOL_VERSION) throw protocolError('unsupported protocol version');
  if (!Number.isSafeInteger(message.id) || typeof message.ok !== 'boolean') {
    throw protocolError('response correlation fields are invalid');
  }
  const id = message.id as number;
  if (message.ok) {
    if (!('result' in message)) throw protocolError('response result is missing');
    return { version: PROTOCOL_VERSION, id, ok: true, result: message.result };
  }
  const error = message.error;
  if (!error || typeof error !== 'object') throw protocolError('response error is invalid');
  const { code, message: text, details } = error as Record<string, unknown>;
  if (typeof text !== 'string' || !isErrorCode(code)) {
    throw protocolError('response error is invalid');
  }
  if (details !== undefined && (details === null || typeof details !== 'object' || Array.isArray(details))) {
    throw protocolError('response error details are invalid');
  }
  return {
    version: PROTOCOL_VERSION,
    id,
    ok: false,
    error: {
      code,
      message: text,
      ...(details === undefined ? {} : { details: details as Readonly<Record<string, unknown>> }),
    },
  };
}
