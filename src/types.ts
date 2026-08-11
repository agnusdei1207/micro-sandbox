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
