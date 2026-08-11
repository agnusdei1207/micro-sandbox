export type SandboxErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'ISOLATION_UNAVAILABLE'
  | 'CGROUP_DELEGATION_REQUIRED'
  | 'CAPACITY_EXCEEDED'
  | 'POLICY_VIOLATION'
  | 'INPUT_TOO_LARGE'
  | 'TYPE_MISMATCH'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'MALFORMED_INPUT'
  | 'DECOMPRESSION_BOMB'
  | 'OUTPUT_TOO_LARGE'
  | 'TIMEOUT'
  | 'OUT_OF_MEMORY'
  | 'PROCESS_LIMIT'
  | 'SECCOMP_VIOLATION'
  | 'PROCESSOR_CRASH'
  | 'OUTPUT_VALIDATION_FAILED'
  | 'SUPERVISOR_UNAVAILABLE'
  | 'CANCELLED'
  | 'INTERNAL_ERROR';

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

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
