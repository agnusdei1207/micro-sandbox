import { cancelledError, SandboxError, toError } from '../errors.js';
import type { SupervisorRequester } from '../types.js';
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

export interface SupervisorClientOptions {
  /**
   * How long an aborted request waits for the supervisor's reply before the client is
   * retired. Retiring closes the transport, which tears down every job it owns, so the
   * request settles only once its workspace can no longer be written.
   */
  readonly cancelGraceMs?: number;
}

export interface ConnectOptions extends SupervisorClientOptions {
  /** Bound on the initial health check; the transport is closed if it is exceeded. */
  readonly startupTimeoutMs?: number;
}

const DEFAULT_CANCEL_GRACE_MS = 10_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

export class SupervisorClient implements SupervisorRequester {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly cancelGraceMs: number;
  private nextId = 1;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    private readonly transport: SupervisorTransport,
    options: SupervisorClientOptions = {},
  ) {
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    transport.onMessage((message) => this.handleMessage(message));
    transport.onClose((error) => this.handleClose(error));
  }

  request(type: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new SandboxError('SUPERVISOR_UNAVAILABLE', 'Sandbox supervisor is closed'),
      );
    }
    if (signal?.aborted) return Promise.reject(cancelledError());

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      let graceTimer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        try {
          // Cancellation is a separate request so its own id never aliases the run's
          // response. The supervisor reads the target from payload.requestId.
          this.transport.send({
            version: PROTOCOL_VERSION,
            id: this.nextId++,
            type: 'cancel',
            payload: { requestId: id },
          });
        } catch {
          // Without a cancellation acknowledgement the job may still own its workspace.
          // Terminate the transport and retain every pending request until it has closed.
          this.retire();
          return;
        }
        graceTimer = setTimeout(() => {
          if (this.pending.has(id)) this.retire();
        }, this.cancelGraceMs);
        graceTimer.unref();
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        removeAbort: () => {
          if (graceTimer) clearTimeout(graceTimer);
          signal?.removeEventListener('abort', onAbort);
        },
      });
      try {
        this.transport.send({ version: PROTOCOL_VERSION, id, type, payload });
      } catch (error) {
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(toError(error));
      }
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.transport.close().finally(() => {
      this.rejectPending(new SandboxError('SUPERVISOR_UNAVAILABLE', 'Sandbox client closed'));
    });
    return this.closePromise;
  }

  private retire(): void {
    void this.close().catch(() => undefined);
  }

  private handleMessage(message: SupervisorInboundMessage): void {
    if (this.closed) return;
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

/**
 * Starts a client on `transport` and waits for a bounded health check. On any failure,
 * including a supervisor that never answers, the transport is closed before rejecting.
 */
export async function connectSupervisor(
  transport: SupervisorTransport,
  options: ConnectOptions = {},
): Promise<SupervisorClient> {
  const client = new SupervisorClient(
    transport,
    options.cancelGraceMs === undefined ? {} : { cancelGraceMs: options.cancelGraceMs },
  );
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SandboxError(
      'SUPERVISOR_UNAVAILABLE',
      'Sandbox supervisor did not become healthy in time',
      { startupTimeoutMs },
    )), startupTimeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([client.request('health', {}), timedOut]);
    return client;
  } catch (error) {
    clearTimeout(timer);
    try {
      await client.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Supervisor startup and cleanup failed');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
