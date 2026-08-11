import type { IsolationPolicy, ResourceLimits } from '../types.js';

export const DEFAULT_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  timeoutMs: 5_000,
  memoryMb: 256,
  cpu: 0.5,
  pids: 16,
  inputBytes: 64 * 1024,
  outputBytes: 256 * 1024,
});

export const DEFAULT_CEILINGS: Readonly<ResourceLimits> = Object.freeze({
  timeoutMs: 30_000,
  memoryMb: 512,
  cpu: 1,
  pids: 32,
  inputBytes: 512 * 1024,
  outputBytes: 512 * 1024,
});

export const REQUIRED_ISOLATION: Readonly<IsolationPolicy> = Object.freeze({
  userNamespace: true,
  pidNamespace: true,
  mountNamespace: true,
  networkNamespace: true,
  ipcNamespace: true,
  utsNamespace: true,
  cgroupNamespace: true,
  cgroupV2: true,
  seccomp: true,
  noNewPrivileges: true,
  capabilitiesDropped: true,
  pivotRoot: true,
});
