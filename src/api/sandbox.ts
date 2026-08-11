import { randomUUID } from 'node:crypto';
import { SandboxError } from '../errors.js';
import { resolveSupervisorBinary } from '../platform/binary.js';
import { resolveSupervisorEnvironment } from '../platform/environment.js';
import { normalizeGuestPath } from '../policy/paths.js';
import { resolvePolicy } from '../policy/resolve.js';
import { SupervisorClient } from '../supervisor/client.js';
import { ChildProcessTransport } from '../supervisor/transport.js';
import type {
  CapacityOptions,
  JobRequest,
  JobResult,
  ProfileDefinition,
  ResolvedProfile,
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

interface WireJobResult extends Omit<JobResult, 'stdout' | 'stderr'> {
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
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
  private resolveClose: (() => void) | undefined;

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

  defineProfile(name: string, definition: ProfileDefinition): Readonly<ResolvedProfile> {
    if (this.requesterPromise) {
      throw new SandboxError(
        'POLICY_VIOLATION',
        'Profiles must be defined before the supervisor starts',
      );
    }
    return this.profiles.define(name, definition);
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
      const profileLimits = entry.request.profile
        ? this.profiles.get(entry.request.profile).limits
        : {};
      const policy = resolvePolicy(this.options, {
        ...profileLimits,
        ...entry.request.limits,
      });
      const runtime = entry.request.runtime
        ? this.runtimes.get(entry.request.runtime)
        : undefined;
      const command = entry.request.command ?? runtime?.entrypoint;
      if (!command) {
        throw new SandboxError(
          'POLICY_VIOLATION',
          'A command or a runtime with an entrypoint is required',
        );
      }
      const result = await requester.request<WireJobResult>(
        'run',
        {
          jobId: `job-${randomUUID().replaceAll('-', '')}`,
          rootfs: runtime?.rootfs ?? this.options.rootfs ?? '/',
          command,
          args: [...(entry.request.args ?? [])],
          cwd: entry.request.cwd ?? '/',
          env: { ...entry.request.env },
          stdinBase64: Buffer.from(entry.request.stdin ?? '').toString('base64'),
          limits: policy.limits,
        },
        entry.request.signal,
      );
      entry.resolve(decodeResult(result));
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
    const override = options.supervisorBinary ?? process.env.MICRO_SANDBOX_BINARY;
    const binary = resolveSupervisorBinary(override ? { override } : {});
    return new SupervisorClient(
      new ChildProcessTransport(binary, resolveSupervisorEnvironment(options)),
    );
  };
}

function validateRequest(request: JobRequest): void {
  if (!request.command && !request.runtime) {
    throw new SandboxError(
      'POLICY_VIOLATION',
      'A command or registered runtime is required',
    );
  }
  if (request.command) normalizeGuestPath(request.command);
  if (request.cwd) normalizeGuestPath(request.cwd);
  if (request.args?.some((argument) => argument.includes('\0'))) {
    throw new SandboxError('POLICY_VIOLATION', 'Command arguments may not contain NUL');
  }
}

function decodeResult(result: WireJobResult): JobResult {
  return Object.freeze({
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    stdout: Buffer.from(result.stdoutBase64, 'base64'),
    stderr: Buffer.from(result.stderrBase64, 'base64'),
    isolation: Object.freeze({ ...result.isolation }),
    metrics: Object.freeze({ ...result.metrics }),
  });
}
