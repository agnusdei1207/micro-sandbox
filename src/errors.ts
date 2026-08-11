export type SandboxErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'ISOLATION_UNAVAILABLE'
  | 'CGROUP_DELEGATION_REQUIRED'
  | 'CGROUP_ERROR'
  | 'CAPACITY_EXCEEDED'
  | 'POLICY_VIOLATION'
  | 'PROTOCOL_ERROR'
  | 'SUPERVISOR_UNAVAILABLE'
  | 'CANCELLED'
  | 'INTERNAL_ERROR';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: SandboxErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SandboxError';
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }
}
