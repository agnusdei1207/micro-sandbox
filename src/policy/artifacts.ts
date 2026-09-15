import { SandboxError } from '../errors.js';
import type { ArtifactLimits } from '../types.js';

export const DEFAULT_ARTIFACT_LIMITS: Readonly<ArtifactLimits> = Object.freeze({
  inputFiles: 16,
  inputBytes: 16 * 1024 * 1024,
  inputFileBytes: 8 * 1024 * 1024,
  outputFiles: 32,
  outputBytes: 32 * 1024 * 1024,
  outputFileBytes: 16 * 1024 * 1024,
});

export const DEFAULT_ARTIFACT_CEILINGS: Readonly<ArtifactLimits> = Object.freeze({
  inputFiles: 128,
  inputBytes: 256 * 1024 * 1024,
  inputFileBytes: 256 * 1024 * 1024,
  outputFiles: 256,
  outputBytes: 256 * 1024 * 1024,
  outputFileBytes: 256 * 1024 * 1024,
});

export function resolveArtifactLimits(
  configuredDefaults: Partial<ArtifactLimits>,
  configuredCeilings: Partial<ArtifactLimits>,
  requested: Partial<ArtifactLimits>,
): Readonly<ArtifactLimits> {
  const defaults = { ...DEFAULT_ARTIFACT_LIMITS, ...configuredDefaults };
  const ceilings = { ...DEFAULT_ARTIFACT_CEILINGS, ...configuredCeilings };
  const limits = { ...defaults, ...requested };
  if (requested.outputFileBytes === undefined) {
    limits.outputFileBytes = Math.min(limits.outputFileBytes, limits.outputBytes);
  }
  for (const key of Object.keys(DEFAULT_ARTIFACT_LIMITS) as Array<keyof ArtifactLimits>) {
    for (const [label, values] of [['default', defaults], ['ceiling', ceilings], ['requested', limits]] as const) {
      if (!Number.isSafeInteger(values[key]) || values[key] <= 0) violation(`${label} artifact ${key} is invalid`);
    }
    if (defaults[key] > ceilings[key] || limits[key] > ceilings[key]) {
      violation(`Artifact ${key} exceeds its ceiling`);
    }
  }
  if (limits.outputFileBytes > limits.outputBytes) violation('Artifact outputFileBytes exceeds outputBytes');
  if (limits.inputFileBytes > limits.inputBytes) violation('Artifact inputFileBytes exceeds inputBytes');
  return Object.freeze(limits);
}

function violation(message: string): never {
  throw new SandboxError('POLICY_VIOLATION', message);
}
