export const ERROR_CODES = [
  'UNSUPPORTED_PLATFORM',
  'ISOLATION_UNAVAILABLE',
  'CGROUP_DELEGATION_REQUIRED',
  'CGROUP_ERROR',
  'CAPACITY_EXCEEDED',
  'POLICY_VIOLATION',
  'PROTOCOL_ERROR',
  'SUPERVISOR_UNAVAILABLE',
  'CANCELLED',
  'INTERNAL_ERROR',
] as const;

export type SandboxErrorCode = (typeof ERROR_CODES)[number];

/** Runtime, registry, and profile identifiers share one grammar. */
export const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/;

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

export function isErrorCode(value: unknown): value is SandboxErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export function policyError(
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): SandboxError {
  return new SandboxError('POLICY_VIOLATION', message, details, causeOptions(cause));
}

export function protocolError(
  message: string,
  details?: Readonly<Record<string, unknown>>,
  cause?: unknown,
): SandboxError {
  return new SandboxError('PROTOCOL_ERROR', message, details, causeOptions(cause));
}

export function cancelledError(cause?: unknown): SandboxError {
  return new SandboxError('CANCELLED', 'Sandbox request was cancelled', undefined, causeOptions(cause));
}

export function isSandboxError(error: unknown, code: SandboxErrorCode): error is SandboxError {
  return error instanceof SandboxError && error.code === code;
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

/** Settles with `promise`, or rejects with CANCELLED as soon as `signal` aborts. */
export async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    throw cancelledError();
  }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function causeOptions(cause: unknown): ErrorOptions | undefined {
  return cause === undefined ? undefined : { cause };
}
