import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { SandboxError, type SandboxErrorCode } from '../errors.js';
import { encodeFrame, FrameDecoder, PROTOCOL_VERSION } from './protocol.js';

export interface SupervisorRequestMessage {
  readonly version: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly type: string;
  readonly payload: unknown;
}

export type SupervisorOutboundMessage = SupervisorRequestMessage;

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
    }
  | {
      readonly version: typeof PROTOCOL_VERSION;
      readonly event: 'heartbeat';
      readonly timestampMs: number;
    };

export interface SupervisorTransport {
  send(message: SupervisorOutboundMessage): void;
  onMessage(listener: (message: SupervisorInboundMessage) => void): () => void;
  onClose(listener: (error?: Error) => void): () => void;
  close(): Promise<void>;
}

export class ChildProcessTransport implements SupervisorTransport {
  private static readonly MAX_QUEUED_BYTES = 64 * 1024 * 1024;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly messages = new Set<(message: SupervisorInboundMessage) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  private readonly decoder = new FrameDecoder();
  private stderr = '';
  private closed = false;
  private exited = false;
  private queuedBytes = 0;
  private backpressured = false;
  private readonly outbound: Buffer[] = [];
  private readonly exitedPromise: Promise<void>;
  private resolveExited!: () => void;

  constructor(binary: string, environment: Readonly<Record<string, string>> = {}) {
    this.child = spawn(binary, ['supervise'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...environment },
    });
    this.exitedPromise = new Promise<void>((resolve) => { this.resolveExited = resolve; });
    this.child.stdout.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-64 * 1024);
    });
    this.child.stdin.on('error', (error) => this.handleClose(error));
    this.child.stdin.on('drain', () => {
      this.backpressured = false;
      this.flushOutbound();
    });
    this.child.once('error', (error) => this.handleClose(error));
    this.child.once('close', () => this.finishLifecycle());
    this.child.once('exit', (code, signal) => {
      this.finishLifecycle();
      this.handleClose(
        new SandboxError('SUPERVISOR_UNAVAILABLE', 'Sandbox supervisor exited', {
          code,
          signal,
          stderr: this.stderr,
        }),
      );
    });
  }

  send(message: SupervisorOutboundMessage): void {
    if (this.closed || !this.child.stdin.writable) {
      throw new SandboxError('SUPERVISOR_UNAVAILABLE', 'Sandbox supervisor is not writable');
    }
    const frame = encodeFrame(message);
    if (this.queuedBytes + frame.length > ChildProcessTransport.MAX_QUEUED_BYTES) {
      throw new SandboxError('CAPACITY_EXCEEDED', 'Supervisor write queue is full');
    }
    this.queuedBytes += frame.length;
    this.outbound.push(frame);
    this.flushOutbound();
  }

  onMessage(listener: (message: SupervisorInboundMessage) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onClose(listener: (error?: Error) => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  async close(): Promise<void> {
    if (!this.exited && this.child.stdin.writable) this.child.stdin.end();
    const timer = setTimeout(() => {
      if (!this.exited) this.child.kill('SIGKILL');
    }, 1_000);
    timer.unref();
    await this.exitedPromise;
    clearTimeout(timer);
  }

  private handleData(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) {
        const validated = validateInboundMessage(message);
        for (const listener of this.messages) {
          listener(validated);
        }
      }
    } catch (error) {
      this.handleClose(error instanceof Error ? error : new Error(String(error)));
      this.child.kill('SIGKILL');
    }
  }

  private flushOutbound(): void {
    while (!this.backpressured && this.outbound.length > 0 && !this.closed) {
      const frame = this.outbound.shift();
      if (!frame) return;
      this.backpressured = !this.child.stdin.write(frame, (error) => {
        this.queuedBytes -= frame.length;
        if (error) this.handleClose(error);
      });
    }
  }

  private handleClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener(error);
  }

  private finishLifecycle(): void {
    if (this.exited) return;
    this.exited = true;
    this.resolveExited();
  }
}

const ERROR_CODES = new Set<SandboxErrorCode>([
  'UNSUPPORTED_PLATFORM', 'ISOLATION_UNAVAILABLE', 'CGROUP_DELEGATION_REQUIRED',
  'CGROUP_ERROR', 'CAPACITY_EXCEEDED', 'POLICY_VIOLATION', 'PROTOCOL_ERROR',
  'SUPERVISOR_UNAVAILABLE', 'CANCELLED', 'INTERNAL_ERROR',
]);

export function validateInboundMessage(value: unknown): SupervisorInboundMessage {
  if (!value || typeof value !== 'object') throw protocolError('message must be an object');
  const message = value as Record<string, unknown>;
  if (message.version !== PROTOCOL_VERSION) throw protocolError('unsupported protocol version');
  if (message.event === 'heartbeat') {
    if (typeof message.timestampMs !== 'number' || !Number.isSafeInteger(message.timestampMs)) {
      throw protocolError('heartbeat timestamp is invalid');
    }
    return message as unknown as SupervisorInboundMessage;
  }
  if (!Number.isSafeInteger(message.id) || typeof message.ok !== 'boolean') {
    throw protocolError('response correlation fields are invalid');
  }
  if (message.ok === true && !('result' in message)) throw protocolError('response result is missing');
  if (message.ok === false) {
    const error = message.error as Record<string, unknown> | undefined;
    if (!error || typeof error.message !== 'string' || typeof error.code !== 'string' ||
        !ERROR_CODES.has(error.code as SandboxErrorCode)) {
      throw protocolError('response error is invalid');
    }
  }
  return message as unknown as SupervisorInboundMessage;
}

function protocolError(message: string): SandboxError {
  return new SandboxError('PROTOCOL_ERROR', message);
}
