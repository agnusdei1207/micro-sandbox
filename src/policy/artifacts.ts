import { policyError } from '../errors.js';
import { layerKnownKeys, rejectUnknownKeys } from './resolve.js';
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

/** The exact key set the native `ArtifactLimits` accepts (`deny_unknown_fields`). */
export const ARTIFACT_LIMIT_KEYS = Object.freeze(
  Object.keys(DEFAULT_ARTIFACT_LIMITS) as Array<keyof ArtifactLimits>,
);

export function resolveArtifactLimits(
  configuredDefaults: Partial<ArtifactLimits>,
  configuredCeilings: Partial<ArtifactLimits>,
  requested: Partial<ArtifactLimits>,
): Readonly<ArtifactLimits> {
  rejectUnknownKeys('artifactDefaults', configuredDefaults, ARTIFACT_LIMIT_KEYS);
  rejectUnknownKeys('artifactCeilings', configuredCeilings, ARTIFACT_LIMIT_KEYS);
  rejectUnknownKeys('artifacts.limits', requested, ARTIFACT_LIMIT_KEYS);
  const defaults = layerKnownKeys(ARTIFACT_LIMIT_KEYS, DEFAULT_ARTIFACT_LIMITS, configuredDefaults);
  const ceilings = layerKnownKeys(ARTIFACT_LIMIT_KEYS, DEFAULT_ARTIFACT_CEILINGS, configuredCeilings);
  const layered = layerKnownKeys(ARTIFACT_LIMIT_KEYS, defaults, requested);
  const limits: ArtifactLimits = requested.outputFileBytes === undefined
    ? { ...layered, outputFileBytes: Math.min(layered.outputFileBytes, layered.outputBytes) }
    : layered;
  for (const key of ARTIFACT_LIMIT_KEYS) {
    for (const [label, values] of [['default', defaults], ['ceiling', ceilings], ['requested', limits]] as const) {
      if (!Number.isSafeInteger(values[key]) || values[key] <= 0) throw policyError(`${label} artifact ${key} is invalid`);
    }
    if (defaults[key] > ceilings[key] || limits[key] > ceilings[key]) {
      throw policyError(`Artifact ${key} exceeds its ceiling`);
    }
  }
  if (limits.outputFileBytes > limits.outputBytes) throw policyError('Artifact outputFileBytes exceeds outputBytes');
  if (limits.inputFileBytes > limits.inputBytes) throw policyError('Artifact inputFileBytes exceeds inputBytes');
  return Object.freeze(limits);
}
