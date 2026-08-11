import { SandboxError } from '../errors.js';
import { resolveSupervisorBinary } from '../platform/binary.js';
import { normalizeGuestPath } from '../policy/paths.js';
import { resolvePolicy } from '../policy/resolve.js';
import { SupervisorClient } from '../supervisor/client.js';
import { ChildProcessTransport } from '../supervisor/transport.js';
import type {
  CapacityOptions,
  JobRequest,
  JobResult,
  RuntimeDefinition,
  SandboxOptions,
  SupervisorRequester,
} from '../types.js';
import { ProfileRegistry } from './profile-registry.js';
import { RuntimeRegistry } from './runtime-registry.js';

type RequesterFactory = () => Promise<SupervisorRequester>;

interface QueueEntry {
  readonly request: JobRequest;
  readonly resolve: (result: JobResult) => void;
  readonly reject: (error: Error) => void;
}

const DEFAULT_CAPACITY: Readonly<CapacityOptions> = Object.freeze({
  maxInFlight: 32,
  maxQueue: 100,
  overload: 'wait',
});

export class Sandbox implements AsyncDisposable {
  readonly runtimes = new RuntimeRegistry();
  readonly profiles = new ProfileRegistry();
  private readonly capacity: Readonly<CapacityOptions>;
  private readonly queue: QueueEntry[] = [];
  private requesterPromise?: Promise<SupervisorRequester>;
  private active = 0;
  private closing = false;
  private closePromise?: Promise<void>;
  private resolveClose?: () => void;

  constructor(
    private readonly options: SandboxOptions = {},
    private readonly requesterFactory: RequesterFactory = defaultRequesterFactory(options),
  ) {
    this.capacity = Object.freeze({ ...DEFAULT_CAPACITY, ...options.capacity });
    if (
      !Number.isInteger(this.capacity.maxInFlight) ||
      this.capacity.maxInFlight <= 0 ||
      !Number.isInteger(this.capacity.maxQueue) ||
      this.capacity.maxQueue < 0
    ) {
      throw new SandboxError('POLICY_VIOLATION', 'Capacity values are invalid');
    }
  }

  run(request: JobRequest): Promise<JobResult> {
    if (this.closing) {
      return Promise.reject(
        new SandboxError('SUPERVISOR_UNAVAILABLE', 'Sandbox is closing'),
      );
    }
    validateRequest(request);
    if (this.active >= this.capacity.maxInFlight && this.queue.length >= this.capacity.maxQueue) {
      return Promise.reject(
        new SandboxError('CAPACITY_EXCEEDED', 'Sandbox queue is full', {
          maxQueue: this.capacity.maxQueue,
        }),
      );
    }

    return new Promise<JobResult>((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.pump();
    });
  }

  registerRuntime(definition: RuntimeDefinition): Readonly<RuntimeDefinition> {
    if (this.requesterPromise) {
      throw new SandboxError(
        'POLICY_VIOLATION',
        'Runtimes must be registered before the supervisor starts',
      );
    }
    return this.runtimes.register(definition);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = new Promise<void>((resolve) => {
      this.resolveClose = resolve;
    });
    this.finishCloseIfIdle();
    return this.closePromise;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private pump(): void {
    while (this.active < this.capacity.maxInFlight && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry) break;
      this.active += 1;
      void this.execute(entry);
    }
  }

  private async execute(entry: QueueEntry): Promise<void> {
    try {
      const requester = await this.getRequester();
      const policy = resolvePolicy(this.options, entry.request.limits);
      const { signal, ...request } = entry.request;
      const result = await requester.request<JobResult>(
        'run',
        { ...request, args: [...(request.args ?? [])], policy },
        signal,
      );
      entry.resolve(result);
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.active -= 1;
      this.pump();
      this.finishCloseIfIdle();
    }
  }

  private getRequester(): Promise<SupervisorRequester> {
    this.requesterPromise ??= this.requesterFactory();
    return this.requesterPromise;
  }

  private finishCloseIfIdle(): void {
    if (!this.closing || this.active > 0 || this.queue.length > 0 || !this.resolveClose) return;
    const resolve = this.resolveClose;
    this.resolveClose = undefined;
    void (async () => {
      if (this.requesterPromise) await (await this.requesterPromise).close();
      resolve();
    })();
  }
}

export async function createSandbox(options: SandboxOptions = {}): Promise<Sandbox> {
  return new Sandbox(options);
}

function defaultRequesterFactory(options: SandboxOptions): RequesterFactory {
  return async () => {
    const binary = resolveSupervisorBinary({
      override: options.supervisorBinary ?? process.env.MICRO_SANDBOX_BINARY,
    });
    return new SupervisorClient(new ChildProcessTransport(binary));
  };
}

function validateRequest(request: JobRequest): void {
  normalizeGuestPath(request.command);
  if (request.cwd) normalizeGuestPath(request.cwd);
  for (const path of Object.keys(request.files ?? {})) normalizeGuestPath(path);
  for (const path of request.outputs ?? []) normalizeGuestPath(path);
  if (request.args?.some((argument) => argument.includes('\0'))) {
    throw new SandboxError('POLICY_VIOLATION', 'Command arguments may not contain NUL');
  }
}
