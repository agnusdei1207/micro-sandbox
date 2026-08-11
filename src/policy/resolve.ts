import { SandboxError } from '../errors.js';
import type { ResolvedPolicy, ResourceLimits, SandboxOptions } from '../types.js';
import { DEFAULT_CEILINGS, DEFAULT_LIMITS, REQUIRED_ISOLATION } from './defaults.js';

export { DEFAULT_CEILINGS, DEFAULT_LIMITS } from './defaults.js';

const INTEGER_FIELDS = new Set<keyof ResourceLimits>([
  'timeoutMs',
  'memoryMb',
  'pids',
  'inputBytes',
  'outputBytes',
]);

function validateLimits(label: string, limits: ResourceLimits): void {
  for (const [field, value] of Object.entries(limits) as Array<
    [keyof ResourceLimits, number]
  >) {
    if (!Number.isFinite(value) || value <= 0 || (INTEGER_FIELDS.has(field) && !Number.isInteger(value))) {
      throw new SandboxError('POLICY_VIOLATION', `${label}.${field} must be a positive finite${INTEGER_FIELDS.has(field) ? ' integer' : ''}`, {
        field,
        value,
      });
    }
  }
}

export function resolvePolicy(
  options: SandboxOptions = {},
  jobLimits: Partial<ResourceLimits> = {},
): ResolvedPolicy {
  const defaults: ResourceLimits = { ...DEFAULT_LIMITS, ...options.defaults };
  const ceilings: ResourceLimits = { ...DEFAULT_CEILINGS, ...options.ceilings };
  const limits: ResourceLimits = { ...defaults, ...jobLimits };

  validateLimits('defaults', defaults);
  validateLimits('ceilings', ceilings);
  validateLimits('limits', limits);

  for (const field of Object.keys(DEFAULT_LIMITS) as Array<keyof ResourceLimits>) {
    if (defaults[field] > ceilings[field]) {
      throw new SandboxError('POLICY_VIOLATION', `Default ${field} exceeds its ceiling`, {
        field,
        value: defaults[field],
        ceiling: ceilings[field],
      });
    }
    if (limits[field] > ceilings[field]) {
      throw new SandboxError('POLICY_VIOLATION', `Requested ${field} exceeds its ceiling`, {
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
