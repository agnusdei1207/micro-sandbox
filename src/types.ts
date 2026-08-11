export interface ResourceLimits {
  readonly timeoutMs: number;
  readonly memoryMb: number;
  readonly cpu: number;
  readonly pids: number;
  readonly inputBytes: number;
  readonly outputBytes: number;
}

export interface SandboxOptions {
  readonly defaults?: Partial<ResourceLimits>;
  readonly ceilings?: Partial<ResourceLimits>;
  readonly capacity?: Partial<CapacityOptions>;
  readonly supervisorBinary?: string;
}

export interface CapacityOptions {
  readonly maxInFlight: number;
  readonly maxQueue: number;
  readonly overload: 'wait' | 'reject';
}

export interface IsolationPolicy {
  readonly namespaces: readonly [
    'user',
    'pid',
    'mount',
    'network',
    'ipc',
    'uts',
    'cgroup',
  ];
  readonly network: 'none';
  readonly cgroupV2: true;
  readonly seccomp: true;
  readonly noNewPrivileges: true;
  readonly dropCapabilities: true;
}

export interface ResolvedPolicy {
  readonly limits: Readonly<ResourceLimits>;
  readonly ceilings: Readonly<ResourceLimits>;
  readonly isolation: Readonly<IsolationPolicy>;
}

export interface JobRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly runtime?: string;
  readonly profile?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: Uint8Array | string;
  readonly files?: Readonly<Record<string, Uint8Array | string>>;
  readonly outputs?: readonly string[];
  readonly limits?: Partial<ResourceLimits>;
  readonly signal?: AbortSignal;
}

export interface JobMetrics {
  readonly durationMs: number;
  readonly peakMemoryBytes: number;
  readonly cpuTimeMs: number;
}

export interface JobResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly files: Readonly<Record<string, Buffer>>;
  readonly isolation: Readonly<IsolationPolicy>;
  readonly metrics: Readonly<JobMetrics>;
}

export interface SupervisorRequester {
  request<T>(type: string, payload: unknown, signal?: AbortSignal): Promise<T>;
  close(): Promise<void>;
}

export interface RuntimeDefinition {
  readonly id: string;
  readonly rootfs: string;
  readonly entrypoint: string;
  readonly digest: `sha256:${string}`;
  readonly profile: string;
  readonly environment?: readonly string[];
}

export interface ProfileDefinition {
  readonly base: string;
  readonly limits?: Partial<ResourceLimits>;
  readonly addSyscalls?: readonly string[];
}

export interface ResolvedProfile {
  readonly name: string;
  readonly base: string;
  readonly limits: Readonly<Partial<ResourceLimits>>;
  readonly addSyscalls: readonly string[];
}
