import {
  collectArtifacts,
  type ArtifactManifestEntry,
  type PreparedWorkspace,
} from '../artifacts/workspace.js';
import { SandboxError } from '../errors.js';
import type { JobResult } from '../types.js';

export interface WireJobResult extends Omit<JobResult, 'stdout' | 'stderr' | 'artifacts'> {
  readonly stdoutBase64: string;
  readonly stderrBase64: string;
  readonly artifacts?: readonly ArtifactManifestEntry[];
}

export async function decodeJobResult(
  result: WireJobResult,
  workspace?: PreparedWorkspace,
  signal?: AbortSignal,
): Promise<JobResult> {
  validateWireResult(result);
  const manifest = result.artifacts ?? [];
  if (manifest.length > 0 && !workspace) {
    protocolViolation('Supervisor returned artifacts without a workspace');
  }
  return Object.freeze({
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    oomKilled: result.oomKilled,
    stdout: Buffer.from(result.stdoutBase64, 'base64'),
    stderr: Buffer.from(result.stderrBase64, 'base64'),
    isolation: Object.freeze({ ...result.isolation }),
    metrics: Object.freeze({ ...result.metrics }),
    artifacts: workspace ? await collectArtifacts(workspace, manifest, signal) : Object.freeze([]),
  });
}

function validateWireResult(result: WireJobResult): void {
  if (!result || typeof result !== 'object') protocolViolation('Job result must be an object');
  if (
    !(result.exitCode === null || Number.isSafeInteger(result.exitCode))
    || !(result.signal === null || Number.isSafeInteger(result.signal))
    || typeof result.timedOut !== 'boolean'
    || typeof result.outputLimitExceeded !== 'boolean'
    || typeof result.oomKilled !== 'boolean'
    || !isCanonicalBase64(result.stdoutBase64)
    || !isCanonicalBase64(result.stderrBase64)
  ) {
    protocolViolation('Supervisor returned an invalid job result');
  }
  const isolation = result.isolation as unknown as Record<string, unknown>;
  for (const key of [
    'userNamespace', 'pidNamespace', 'mountNamespace', 'networkNamespace',
    'ipcNamespace', 'utsNamespace', 'cgroupNamespace', 'cgroupV2', 'seccomp',
    'noNewPrivileges', 'capabilitiesDropped', 'pivotRoot',
  ]) {
    if (isolation?.[key] !== true) protocolViolation(`Supervisor did not attest ${key}`);
  }
  if (
    !Number.isSafeInteger(result.metrics?.durationMs)
    || result.metrics.durationMs < 0
    || !Number.isSafeInteger(result.metrics.peakMemoryBytes)
    || result.metrics.peakMemoryBytes < 0
    || (result.artifacts !== undefined && !Array.isArray(result.artifacts))
  ) {
    protocolViolation('Supervisor returned invalid metrics or artifacts');
  }
}

function isCanonicalBase64(value: unknown): value is string {
  if (
    typeof value !== 'string'
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function protocolViolation(message: string): never {
  throw new SandboxError('PROTOCOL_ERROR', message);
}
