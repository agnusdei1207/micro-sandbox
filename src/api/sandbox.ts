import { randomUUID } from 'node:crypto';
import {
  defaultWorkspaceRoot,
  prepareWorkspace,
  removeWorkspace,
  reserveWorkspaceCapacity,
} from '../artifacts/workspace.js';
import { SandboxError } from '../errors.js';
import { resolveSupervisorBinary } from '../platform/binary.js';
import { resolveSupervisorEnvironment } from '../platform/environment.js';
import { resolveArtifactLimits } from '../policy/artifacts.js';
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
import { decodeJobResult, type WireJobResult } from './job-result.js';

type RequesterFactory = () => Promise<SupervisorRequester>;

interface QueueEntry {
  readonly request: JobRequest;
  readonly resolve: (result: JobResult) => void;
  readonly reject: (error: Error) => void;
  removeAbort?: () => void;
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
  private requesterPromise: Promise<SupervisorRequester> | undefined;
  private active = 0;
  private closing = false;
  private closePromise?: Promise<void>;
  private resolveClose: (() => void) | undefined;
  private rejectClose: ((error: unknown) => void) | undefined;
  private readonly options: SandboxOptions;
  private readonly requesterFactory: RequesterFactory;
  private readonly workspaceRoot: string;
  private readonly ownsWorkspaceRoot: boolean;
  private workspaceReservedBytes = 0n;

  constructor(
    options: SandboxOptions = {},
    requesterFactory?: RequesterFactory,
  ) {
    this.ownsWorkspaceRoot = options.workspaceRoot === undefined;
    this.workspaceRoot = options.workspaceRoot ?? defaultWorkspaceRoot();
    this.options = Object.freeze({ ...options, workspaceRoot: this.workspaceRoot });
    this.requesterFactory = requesterFactory ?? defaultRequesterFactory(this.options);
    this.capacity = Object.freeze({ ...DEFAULT_CAPACITY, ...options.capacity });
    if (
      !Number.isInteger(this.capacity.maxInFlight) ||
      this.capacity.maxInFlight <= 0 ||
      this.capacity.maxInFlight > 64 ||
      !Number.isInteger(this.capacity.maxQueue) ||
      this.capacity.maxQueue < 0
      || this.capacity.maxQueue > 10_000
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
    if (request.signal?.aborted) {
      return Promise.reject(new SandboxError('CANCELLED', 'Sandbox request was cancelled'));
    }
    if (
      this.active >= this.capacity.maxInFlight &&
      (this.capacity.overload === 'reject' || this.queue.length >= this.capacity.maxQueue)
    ) {
      return Promise.reject(
        new SandboxError('CAPACITY_EXCEEDED', 'Sandbox queue is full', {
          maxQueue: this.capacity.maxQueue,
        }),
      );
    }

    return new Promise<JobResult>((resolve, reject) => {
      const entry: QueueEntry = { request, resolve, reject };
      if (request.signal) {
        const onAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index === -1) return;
          this.queue.splice(index, 1);
          reject(new SandboxError('CANCELLED', 'Sandbox request was cancelled'));
          this.finishCloseIfIdle();
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
        entry.removeAbort = () => request.signal?.removeEventListener('abort', onAbort);
      }
      this.queue.push(entry);
      this.pump();
    });
  }

  registerRuntime(definition: RuntimeDefinition): Readonly<RuntimeDefinition> {
    return this.runtimes.register(definition);
  }

  defineProfile(name: string, definition: ProfileDefinition): Readonly<ResolvedProfile> {
    return this.profiles.define(name, definition);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = new Promise<void>((resolve, reject) => {
      this.resolveClose = resolve;
      this.rejectClose = reject;
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
      entry.removeAbort?.();
      this.active += 1;
      void this.execute(entry);
    }
  }

  private async execute(entry: QueueEntry): Promise<void> {
    let workspace: Awaited<ReturnType<typeof prepareWorkspace>> | undefined;
    let workspaceReservation = 0n;
    let completed: JobResult | undefined;
    let failure: unknown;
    let requesterPromise: Promise<SupervisorRequester> | undefined;
    try {
      const payload = this.resolveRunPayload(entry.request);
      if (entry.request.artifacts) {
        const limits = resolveArtifactLimits(
          this.options.artifactDefaults ?? {},
          this.options.artifactCeilings ?? {},
          entry.request.artifacts.limits ?? {},
        );
        const capacity = await reserveWorkspaceCapacity(
          this.workspaceRoot,
          limits,
        );
        if (this.workspaceReservedBytes + capacity.requested > capacity.usable) {
          throw new SandboxError(
            'CAPACITY_EXCEEDED',
            'Concurrent artifact jobs exceed the workspace free-space reserve',
          );
        }
        workspaceReservation = capacity.requested;
        this.workspaceReservedBytes += workspaceReservation;
        workspace = await prepareWorkspace(
          this.workspaceRoot,
          entry.request.artifacts,
          limits,
          entry.request.signal,
        );
      }
      requesterPromise = this.getRequester();
      const requester = await requesterPromise;
      const result = await requester.request<WireJobResult>(
        'run',
        {
          jobId: `job-${randomUUID().replaceAll('-', '')}`,
          ...payload,
          ...(workspace ? { workspace } : {}),
        },
        entry.request.signal,
      );
      completed = await decodeJobResult(result, workspace, entry.request.signal);
    } catch (error) {
      failure = error;
      if (error instanceof SandboxError && error.code === 'SUPERVISOR_UNAVAILABLE') {
        // A delayed failure from an old supervisor must not discard its replacement.
        if (this.requesterPromise === requesterPromise) this.requesterPromise = undefined;
        const requester = await requesterPromise?.catch(() => undefined);
        if (requester) {
          try {
            await requester.close();
          } catch (cleanupError) {
            failure = new AggregateError([error, cleanupError], 'Supervisor failure and cleanup failed');
          }
        }
      }
    } finally {
      try {
        if (workspace) await removeWorkspace(workspace.path);
      } catch (error) {
        failure ??= error;
      } finally {
        this.workspaceReservedBytes -= workspaceReservation;
        this.active -= 1;
        this.pump();
        this.finishCloseIfIdle();
      }
    }
    if (failure !== undefined) {
      entry.reject(failure instanceof Error ? failure : new Error(String(failure)));
    } else if (completed) {
      entry.resolve(completed);
    } else {
      entry.reject(new SandboxError('INTERNAL_ERROR', 'Sandbox job completed without a result'));
    }
  }

  private resolveRunPayload(request: JobRequest) {
    const profileLimits = request.profile ? this.profiles.get(request.profile).limits : {};
    const policy = resolvePolicy(this.options, { ...profileLimits, ...request.limits });
    const runtime = request.runtime ? this.runtimes.get(request.runtime) : undefined;
    const command = request.command ?? runtime?.entrypoint;
    if (!command) {
      throw new SandboxError('POLICY_VIOLATION', 'A command or a runtime with an entrypoint is required');
    }
    const stdin = request.stdin ?? '';
    if (Buffer.byteLength(stdin) > policy.limits.inputBytes) {
      throw new SandboxError('POLICY_VIOLATION', 'Stdin exceeds its byte limit');
    }
    return {
      rootfs: runtime?.rootfs ?? this.options.rootfs ?? '/',
      command: normalizeGuestPath(command),
      args: [...(request.args ?? [])],
      cwd: normalizeGuestPath(request.cwd ?? '/', true),
      env: { ...request.env },
      stdinBase64: Buffer.from(stdin).toString('base64'),
      limits: policy.limits,
    };
  }

  private getRequester(): Promise<SupervisorRequester> {
    this.runtimes.lock();
    this.profiles.lock();
    this.requesterPromise ??= this.requesterFactory();
    return this.requesterPromise;
  }

  private finishCloseIfIdle(): void {
    if (
      !this.closing ||
      this.active > 0 ||
      this.queue.length > 0 ||
      !this.resolveClose ||
      !this.rejectClose
    ) return;
    const resolve = this.resolveClose;
    const reject = this.rejectClose;
    this.resolveClose = undefined;
    this.rejectClose = undefined;
    void (async () => {
      try {
        try {
          if (this.requesterPromise) await (await this.requesterPromise).close();
        } finally {
          if (this.ownsWorkspaceRoot) await removeWorkspace(this.workspaceRoot);
        }
        resolve();
      } catch (error) {
        reject(error);
      }
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
    const client = new SupervisorClient(
      new ChildProcessTransport(binary, resolveSupervisorEnvironment(options)),
    );
    try {
      await client.request('health', {});
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
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
  if (request.cwd) normalizeGuestPath(request.cwd, true);
  if (request.args?.some((argument) => argument.includes('\0'))) {
    throw new SandboxError('POLICY_VIOLATION', 'Command arguments may not contain NUL');
  }
}
