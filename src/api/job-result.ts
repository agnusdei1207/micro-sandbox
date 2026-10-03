import {
  collectArtifacts,
  type ArtifactManifestEntry,
  type PreparedWorkspace,
} from '../artifacts/workspace.js';
import { protocolError } from '../errors.js';
import { REQUIRED_ISOLATION } from '../policy/defaults.js';
import type { JobResult } from '../types.js';

interface WireJobResult {
  readonly exitCode: number | null;
  readonly signal: number | null;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly oomKilled: boolean;
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
  readonly metrics: { readonly durationMs: number; readonly peakMemoryBytes: number };
  readonly artifacts: readonly unknown[];
}

export async function decodeJobResult(
  value: unknown,
  workspace?: PreparedWorkspace,
  signal?: AbortSignal,
): Promise<JobResult> {
  const result = validateWireResult(value);
  if (result.artifacts.length > 0 && !workspace) {
    throw protocolError('Supervisor returned artifacts without a workspace');
  }
  return Object.freeze({
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    oomKilled: result.oomKilled,
    stdout: Buffer.from(result.stdoutBase64, 'base64'),
    stderr: Buffer.from(result.stderrBase64, 'base64'),
    isolation: REQUIRED_ISOLATION,
    metrics: Object.freeze({
      durationMs: result.metrics.durationMs,
      peakMemoryBytes: result.metrics.peakMemoryBytes,
    }),
    artifacts: workspace
      ? await collectArtifacts(workspace, result.artifacts as readonly ArtifactManifestEntry[], signal)
      : Object.freeze([]),
  });
}

function validateWireResult(value: unknown): WireJobResult {
  if (!isRecord(value)) throw protocolError('Job result must be an object');
  if (
    !(value.exitCode === null || Number.isSafeInteger(value.exitCode))
    || !(value.signal === null || Number.isSafeInteger(value.signal))
    || typeof value.timedOut !== 'boolean'
    || typeof value.outputLimitExceeded !== 'boolean'
    || typeof value.oomKilled !== 'boolean'
    || !isCanonicalBase64(value.stdoutBase64)
    || !isCanonicalBase64(value.stderrBase64)
  ) {
    throw protocolError('Supervisor returned an invalid job result');
  }
  const isolation = isRecord(value.isolation) ? value.isolation : {};
  for (const key of Object.keys(REQUIRED_ISOLATION)) {
    if (isolation[key] !== true) throw protocolError(`Supervisor did not attest ${key}`);
  }
  const metrics = isRecord(value.metrics) ? value.metrics : {};
  const { durationMs, peakMemoryBytes } = metrics;
  if (
    typeof durationMs !== 'number' || !Number.isSafeInteger(durationMs) || durationMs < 0
    || typeof peakMemoryBytes !== 'number' || !Number.isSafeInteger(peakMemoryBytes)
    || peakMemoryBytes < 0
    || (value.artifacts !== undefined && !Array.isArray(value.artifacts))
  ) {
    throw protocolError('Supervisor returned invalid metrics or artifacts');
  }
  return {
    exitCode: value.exitCode as number | null,
    signal: value.signal as number | null,
    timedOut: value.timedOut,
    outputLimitExceeded: value.outputLimitExceeded,
    oomKilled: value.oomKilled,
    stdoutBase64: value.stdoutBase64,
    stderrBase64: value.stderrBase64,
    metrics: { durationMs, peakMemoryBytes },
    artifacts: (value.artifacts as readonly unknown[] | undefined) ?? [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isCanonicalBase64(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}
