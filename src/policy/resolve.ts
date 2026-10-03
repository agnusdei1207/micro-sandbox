import { policyError } from '../errors.js';
import type { ResolvedPolicy, ResourceLimits, SandboxOptions } from '../types.js';
import { DEFAULT_CEILINGS, DEFAULT_LIMITS, REQUIRED_ISOLATION } from './defaults.js';

export { DEFAULT_CEILINGS, DEFAULT_LIMITS } from './defaults.js';

/** The exact key set the native `ResourceLimits` accepts (`deny_unknown_fields`). */
export const LIMIT_KEYS = Object.freeze(
  Object.keys(DEFAULT_LIMITS) as Array<keyof ResourceLimits>,
);

/** Mirrors the native CPU quota bounds (1 ms per 100 ms period up to 1024 CPUs). */
const CPU_MIN = 0.01;
const CPU_MAX = 1024;

const INTEGER_FIELDS = new Set<keyof ResourceLimits>([
  'timeoutMs',
  'memoryMb',
  'pids',
  'inputBytes',
  'outputBytes',
]);

/**
 * Rejects keys outside `known` so a typo or stale field fails as POLICY_VIOLATION
 * in Node instead of as an opaque native deserialization error.
 */
export function rejectUnknownKeys(
  label: string,
  value: unknown,
  known: readonly string[],
): void {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw policyError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw policyError(`${label}.${key} is not a supported limit`, { field: key });
    }
  }
}

/** Validates the shape and values of a partial limit override such as a profile. */
export function validatePartialLimits(label: string, limits: unknown): void {
  rejectUnknownKeys(label, limits, LIMIT_KEYS);
  if (limits === undefined) return;
  const values = limits as Partial<ResourceLimits>;
  for (const field of LIMIT_KEYS) {
    if (field in values) validateLimit(label, field, values[field]);
  }
}

function validateLimit(label: string, field: keyof ResourceLimits, value: unknown): void {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value <= 0
    || (INTEGER_FIELDS.has(field) && !Number.isSafeInteger(value))
  ) {
    throw policyError(
      `${label}.${field} must be a positive finite${INTEGER_FIELDS.has(field) ? ' integer' : ''}`,
      { field, value },
    );
  }
  if (field === 'cpu' && (value < CPU_MIN || value > CPU_MAX)) {
    throw policyError(`${label}.cpu must be between ${CPU_MIN} and ${CPU_MAX}`, { field, value });
  }
}

/**
 * Layers partial overrides left to right and rebuilds the result from `keys` only,
 * so the wire payload never carries a field the native schema would refuse.
 */
export function layerKnownKeys<T extends object>(
  keys: readonly (keyof T)[],
  ...sources: Array<Partial<T> | undefined>
): T {
  const merged: Partial<T> = Object.assign({}, ...sources);
  const result: Partial<T> = {};
  for (const key of keys) result[key] = merged[key];
  return result as T;
}

export function resolvePolicy(
  options: SandboxOptions = {},
  jobLimits: Partial<ResourceLimits> = {},
): ResolvedPolicy {
  rejectUnknownKeys('defaults', options.defaults, LIMIT_KEYS);
  rejectUnknownKeys('ceilings', options.ceilings, LIMIT_KEYS);
  rejectUnknownKeys('limits', jobLimits, LIMIT_KEYS);
  const defaults = layerKnownKeys(LIMIT_KEYS, DEFAULT_LIMITS, options.defaults);
  const ceilings = layerKnownKeys(LIMIT_KEYS, DEFAULT_CEILINGS, options.ceilings);
  const limits = layerKnownKeys(LIMIT_KEYS, defaults, jobLimits);

  for (const [label, values] of [['defaults', defaults], ['ceilings', ceilings], ['limits', limits]] as const) {
    for (const field of LIMIT_KEYS) validateLimit(label, field, values[field]);
  }

  for (const field of LIMIT_KEYS) {
    if (defaults[field] > ceilings[field]) {
      throw policyError(`Default ${field} exceeds its ceiling`, {
        field,
        value: defaults[field],
        ceiling: ceilings[field],
      });
    }
    if (limits[field] > ceilings[field]) {
      throw policyError(`Requested ${field} exceeds its ceiling`, {
        field,
        value: limits[field],
        ceiling: ceilings[field],
      });
    }
  }

  return Object.freeze({
    limits: Object.freeze(limits),
    ceilings: Object.freeze(ceilings),
    isolation: REQUIRED_ISOLATION,
  });
}
