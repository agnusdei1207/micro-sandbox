import path from 'node:path';
import { SandboxError } from '../errors.js';
import type { SandboxOptions } from '../types.js';

export function resolveSupervisorEnvironment(
  options: Pick<SandboxOptions, 'cgroupRoot'>,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> {
  const cgroupRoot = options.cgroupRoot ?? source.MICRO_SANDBOX_CGROUP_ROOT;
  if (!cgroupRoot) {
    throw new SandboxError(
      'CGROUP_DELEGATION_REQUIRED',
      'Set cgroupRoot or MICRO_SANDBOX_CGROUP_ROOT to a delegated cgroup v2 directory',
    );
  }
  if (!path.posix.isAbsolute(cgroupRoot) || cgroupRoot.includes('\0')) {
    throw new SandboxError(
      'POLICY_VIOLATION',
      'The delegated cgroup root must be an absolute Linux path',
    );
  }
  return Object.freeze({ MICRO_SANDBOX_CGROUP_ROOT: cgroupRoot });
}
