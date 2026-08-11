import type { IsolationPolicy, ResourceLimits } from '../types.js';

const MIB = 1024 * 1024;

export const DEFAULT_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  timeoutMs: 5_000,
  memoryMb: 256,
  cpu: 0.5,
  pids: 16,
  inputBytes: 25 * MIB,
  outputBytes: 50 * MIB,
});

export const DEFAULT_CEILINGS: Readonly<ResourceLimits> = Object.freeze({
  timeoutMs: 30_000,
  memoryMb: 512,
  cpu: 1,
  pids: 32,
  inputBytes: 100 * MIB,
  outputBytes: 200 * MIB,
});

export const REQUIRED_ISOLATION: Readonly<IsolationPolicy> = Object.freeze({
  namespaces: Object.freeze([
    'user',
    'pid',
    'mount',
    'network',
    'ipc',
    'uts',
    'cgroup',
  ]) as IsolationPolicy['namespaces'],
  network: 'none',
  cgroupV2: true,
  seccomp: true,
  noNewPrivileges: true,
  dropCapabilities: true,
});
