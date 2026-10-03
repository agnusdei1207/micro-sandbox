import { randomUUID } from 'node:crypto';
import {
  defaultWorkspaceRoot,
  planArtifacts,
  prepareWorkspace,
  removeWorkspace,
  reserveWorkspaceCapacity,
  type ArtifactPlan,
  type PreparedWorkspace,
} from '../artifacts/workspace.js';
import {
  cancelledError,
  isSandboxError,
  policyError,
  raceAbort,
  SandboxError,
  throwIfAborted,
  toError,
} from '../errors.js';
import { resolveSupervisorBinary } from '../platform/binary.js';
import { resolveSupervisorEnvironment } from '../platform/environment.js';
import { resolveArtifactLimits } from '../policy/artifacts.js';
import { normalizeGuestPath } from '../policy/paths.js';
import { resolvePolicy } from '../policy/resolve.js';
import { connectSupervisor } from '../supervisor/client.js';
import { ChildProcessTransport } from '../supervisor/transport.js';
import type {
  CapacityOptions,
  JobRequest,
  JobResult,
  ProfileDefinition,
  ResolvedProfile,
  ResourceLimits,
  RuntimeDefinition,
  SandboxOptions,
  SupervisorRequester,
} from '../types.js';
import { ProfileRegistry } from './profile-registry.js';
import { RuntimeRegistry } from './runtime-registry.js';
import { decodeJobResult } from './job-result.js';

type RequesterFactory = () => Promise<SupervisorRequester>;

/** Mirror of the native `LaunchSpec` (native/src/job.rs, `deny_unknown_fields`). */
interface WireLaunchSpec {
  readonly jobId: string;
  readonly rootfs: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdinBase64: string;
  readonly limits: Readonly<ResourceLimits>;
  readonly workspace?: PreparedWorkspace;
}

/** A request validated and snapshotted when run() is called. */
interface PreparedJob {
  readonly spec: Omit<WireLaunchSpec, 'jobId' | 'workspace'>;
  readonly artifacts: ArtifactPlan | undefined;
  readonly signal: AbortSignal | undefined;
}

interface QueueEntry {
  readonly job: PreparedJob;
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

  /**
   * @param options Instance configuration.
   * @param requesterFactory Internal test hook that replaces the native supervisor.
   * It is not part of the supported API; construct with `new Sandbox(options)` or
   * `createSandbox(options)`.
   */
  constructor(
    options: SandboxOptions = {},
    /** @deprecated Internal test hook; not supported for application use. */
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
      this.capacity.maxQueue < 0 ||
      this.capacity.maxQueue > 10_000 ||
      (this.capacity.overload !== 'wait' && this.capacity.overload !== 'reject')
    ) {
      throw policyError('Capacity values are invalid');
    }
  }

  /**
   * Validates and snapshots `request`, then queues it. Every failure, including an
   * invalid request, is reported through the returned promise.
   */
  async run(request: JobRequest): Promise<JobResult> {
    if (this.closing) {
      throw new SandboxError('SUPERVISOR_UNAVAILABLE', 'Sandbox is closing');
    }
    const job = this.prepareJob(request);
    throwIfAborted(job.signal);
    if (
      this.active >= this.capacity.maxInFlight &&
      (this.capacity.overload === 'reject' || this.queue.length >= this.capacity.maxQueue)
    ) {
      throw new SandboxError('CAPACITY_EXCEEDED', 'Sandbox queue is full', {
        maxQueue: this.capacity.maxQueue,
      });
    }

    return new Promise<JobResult>((resolve, reject) => {
      const entry: QueueEntry = { job, resolve, reject };
      const { signal } = job;
      if (signal) {
        const onAbort = () => {
          const index = this.queue.indexOf(entry);
          if (index === -1) return;
          this.queue.splice(index, 1);
          reject(cancelledError());
          this.finishCloseIfIdle();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.removeAbort = () => signal.removeEventListener('abort', onAbort);
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
    let outcome: { readonly result: JobResult } | { readonly error: unknown };
    try {
      outcome = {
        result: await this.withWorkspace(
          entry.job,
          (workspace) => this.dispatch(entry.job, workspace),
        ),
      };
    } catch (error) {
      outcome = { error };
    } finally {
      this.active -= 1;
      this.pump();
      this.finishCloseIfIdle();
    }
    if ('result' in outcome) entry.resolve(outcome.result);
    else entry.reject(toError(outcome.error));
  }

  /**
   * Reserves free space, stages inputs, runs `operation`, and always removes the
   * workspace afterwards. The operation's own failure takes precedence over a cleanup
   * failure.
   */
  private async withWorkspace<T>(
    job: PreparedJob,
    operation: (workspace?: PreparedWorkspace) => Promise<T>,
  ): Promise<T> {
    if (!job.artifacts) return operation();
    const capacity = await reserveWorkspaceCapacity(this.workspaceRoot, job.artifacts.limits);
    if (this.workspaceReservedBytes + capacity.requested > capacity.usable) {
      throw new SandboxError(
        'CAPACITY_EXCEEDED',
        'Concurrent artifact jobs exceed the workspace free-space reserve',
      );
    }
    this.workspaceReservedBytes += capacity.requested;
    try {
      const workspace = await prepareWorkspace(this.workspaceRoot, job.artifacts, job.signal);
      let result: T;
      try {
        result = await operation(workspace);
      } catch (error) {
        await removeWorkspace(workspace.path).catch(() => undefined);
        throw error;
      }
      await removeWorkspace(workspace.path);
      return result;
    } finally {
      this.workspaceReservedBytes -= capacity.requested;
    }
  }

  private async dispatch(job: PreparedJob, workspace?: PreparedWorkspace): Promise<JobResult> {
    const requesterPromise = this.getRequester();
    // Startup is shared; an aborted caller stops waiting without cancelling it.
    const requester = await raceAbort(requesterPromise, job.signal);
    const spec: WireLaunchSpec = {
      jobId: `job-${randomUUID().replaceAll('-', '')}`,
      ...job.spec,
      ...(workspace ? { workspace } : {}),
    };
    let wire: unknown;
    try {
      wire = await requester.request('run', spec, job.signal);
    } catch (error) {
      throw await this.recoverRequester(error, requesterPromise, job.signal);
    }
    return decodeJobResult(wire, workspace, job.signal);
  }

  /**
   * Retires a supervisor that failed underneath a request and waits for it to close,
   * so the request's workspace is no longer in use. Returns the error to report.
   */
  private async recoverRequester(
    error: unknown,
    requesterPromise: Promise<SupervisorRequester>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (!isSandboxError(error, 'SUPERVISOR_UNAVAILABLE')) return error;
    // A delayed failure from an old supervisor must not discard its replacement.
    if (this.requesterPromise === requesterPromise) this.requesterPromise = undefined;
    try {
      await (await requesterPromise).close();
    } catch (cleanupError) {
      return new AggregateError([error, cleanupError], 'Supervisor failure and cleanup failed');
    }
    // A caller who aborted sees CANCELLED even when the supervisor had to be retired
    // because it did not acknowledge the cancellation in time.
    return signal?.aborted ? cancelledError(error) : error;
  }

  private prepareJob(request: JobRequest): PreparedJob {
    if (!request || typeof request !== 'object') throw policyError('Job request must be an object');
    const runtime = request.runtime ? this.runtimes.get(request.runtime) : undefined;
    const command = request.command ?? runtime?.entrypoint;
    if (!command) {
      throw policyError('A command or a runtime with an entrypoint is required');
    }
    const profileLimits = request.profile ? this.profiles.get(request.profile).limits : {};
    const policy = resolvePolicy(this.options, { ...profileLimits, ...request.limits });
    const args: unknown = request.args ?? [];
    if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) {
      throw policyError('Command arguments must be an array of strings');
    }
    if ((args as string[]).some((argument) => argument.includes('\0'))) {
      throw policyError('Command arguments may not contain NUL');
    }
    const env: unknown = request.env ?? {};
    if (
      env === null || typeof env !== 'object'
      || Object.values(env).some((value) => typeof value !== 'string')
    ) {
      throw policyError('Environment must map names to string values');
    }
    const stdin: unknown = request.stdin ?? '';
    if (typeof stdin !== 'string' && !(stdin instanceof Uint8Array)) {
      throw policyError('Stdin must be a string or Uint8Array');
    }
    if (Buffer.byteLength(stdin) > policy.limits.inputBytes) {
      throw policyError('Stdin exceeds its byte limit');
    }
    const spec = Object.freeze({
      rootfs: runtime?.rootfs ?? this.options.rootfs ?? '/',
      command: normalizeGuestPath(command),
      args: Object.freeze([...(args as string[])]),
      cwd: normalizeGuestPath(request.cwd ?? '/', true),
      env: Object.freeze({ ...(env as Record<string, string>) }),
      stdinBase64: Buffer.from(stdin).toString('base64'),
      limits: policy.limits,
    });
    const artifacts = request.artifacts === undefined
      ? undefined
      : planArtifacts(
          request.artifacts,
          resolveArtifactLimits(
            this.options.artifactDefaults ?? {},
            this.options.artifactCeilings ?? {},
            request.artifacts?.limits ?? {},
          ),
        );
    return Object.freeze({ spec, artifacts, signal: request.signal });
  }

  private getRequester(): Promise<SupervisorRequester> {
    this.runtimes.lock();
    this.profiles.lock();
    if (!this.requesterPromise) {
      let startup: Promise<SupervisorRequester>;
      try {
        startup = this.requesterFactory();
      } catch (error) {
        startup = Promise.reject(toError(error));
      }
      this.requesterPromise = startup;
      // A failed startup is never cached: the next request starts a fresh supervisor.
      startup.catch(() => {
        if (this.requesterPromise === startup) this.requesterPromise = undefined;
      });
    }
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
          // A failed startup owns nothing; its error was already reported to the run.
          const requester = await this.requesterPromise?.catch(() => undefined);
          await requester?.close();
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
    return connectSupervisor(
      new ChildProcessTransport(binary, resolveSupervisorEnvironment(options)),
    );
  };
}
