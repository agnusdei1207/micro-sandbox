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
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly messages = new Set<(message: SupervisorInboundMessage) => void>();
  private readonly closes = new Set<(error?: Error) => void>();
  private readonly decoder = new FrameDecoder();
  private stderr = '';
  private closed = false;

  constructor(binary: string) {
    this.child = spawn(binary, ['supervise'], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-64 * 1024);
    });
    this.child.once('error', (error) => this.handleClose(error));
    this.child.once('exit', (code, signal) => {
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
    this.child.stdin.write(encodeFrame(message));
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
    if (this.closed) return;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      if (this.closed) return resolve();
      this.child.once('exit', () => resolve());
      setTimeout(() => {
        if (!this.closed) this.child.kill('SIGKILL');
        resolve();
      }, 1_000).unref();
    });
  }

  private handleData(chunk: Buffer): void {
    try {
      for (const message of this.decoder.push(chunk)) {
        for (const listener of this.messages) {
          listener(message as SupervisorInboundMessage);
        }
      }
    } catch (error) {
      this.handleClose(error instanceof Error ? error : new Error(String(error)));
      this.child.kill('SIGKILL');
    }
  }

  private handleClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener(error);
  }
}
