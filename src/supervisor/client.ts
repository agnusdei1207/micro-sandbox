import { SandboxError } from '../errors.js';
import { PROTOCOL_VERSION } from './protocol.js';
import type {
  SupervisorInboundMessage,
  SupervisorTransport,
} from './transport.js';

interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly removeAbort: (() => void) | undefined;
}

export class SupervisorClient {
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly transport: SupervisorTransport) {
    transport.onMessage((message) => this.handleMessage(message));
    transport.onClose((error) => this.handleClose(error));
  }

  request<T>(type: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new SandboxError('SUPERVISOR_UNAVAILABLE', 'Sandbox supervisor is closed'),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(new SandboxError('CANCELLED', 'Sandbox request was cancelled'));
    }

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        try {
          this.transport.send({
            version: PROTOCOL_VERSION,
            id,
            type: 'cancel',
            payload: { requestId: id },
          });
        } catch (error) {
          this.pending.delete(id);
          signal?.removeEventListener('abort', onAbort);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        removeAbort: signal
          ? () => signal.removeEventListener('abort', onAbort)
          : undefined,
      });
      try {
        this.transport.send({ version: PROTOCOL_VERSION, id, type, payload });
      } catch (error) {
        this.pending.delete(id);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new SandboxError('SUPERVISOR_UNAVAILABLE', 'Sandbox client closed'));
    await this.transport.close();
  }

  private handleMessage(message: SupervisorInboundMessage): void {
    if ('event' in message) return;
    if (message.version !== PROTOCOL_VERSION) {
      this.handleClose(new Error(`Unsupported supervisor protocol ${message.version}`));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.removeAbort?.();
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(
        new SandboxError(
          message.error.code,
          message.error.message,
          message.error.details,
        ),
      );
    }
  }

  private handleClose(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(
      new SandboxError('SUPERVISOR_UNAVAILABLE', 'Sandbox supervisor unavailable', undefined, {
        cause: error,
      }),
    );
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.removeAbort?.();
      pending.reject(error);
    }
    this.pending.clear();
  }
}
