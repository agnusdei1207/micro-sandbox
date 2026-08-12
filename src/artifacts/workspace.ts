import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SandboxError } from '../errors.js';
import type {
  ArtifactInput,
  ArtifactLimits,
  ArtifactRequest,
  OutputArtifact,
} from '../types.js';

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

export interface ArtifactManifestEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PreparedWorkspace {
  readonly path: string;
  readonly limits: Readonly<ArtifactLimits>;
  readonly outputs: readonly Readonly<{ path: string; maxBytes: number; required: boolean }>[];
}

export function defaultWorkspaceRoot(): string {
  return path.join(tmpdir(), `micro-sandbox-${process.pid}-${randomUUID()}`);
}

export async function prepareWorkspace(
  root: string,
  request: ArtifactRequest,
  limits: Readonly<ArtifactLimits>,
  signal?: AbortSignal,
): Promise<PreparedWorkspace> {
  const inputs = request.inputs ?? [];
  if (inputs.length > limits.inputFiles) violation('Artifact input file count exceeds its limit');
  const requestedOutputs = request.outputs ?? [];
  if (requestedOutputs.length > limits.outputFiles) {
    violation('Artifact output file count is invalid');
  }
  const workspace = path.join(root, `job-${randomUUID()}`);
  const inputRoot = path.join(workspace, 'input');
  let total = 0;
  const targets = new Set<string>();
  try {
    await mkdir(inputRoot, { recursive: true, mode: 0o700 });
    const outputRoot = path.join(workspace, 'output');
    await mkdir(outputRoot, { mode: 0o700 });
    for (const input of inputs) {
      throwIfAborted(signal);
      const modeCount = Number('data' in input) + Number('sourcePath' in input)
        + Number('stream' in input) + Number('iterable' in input);
      if (modeCount !== 1) violation('Artifact input must define exactly one source');
      const target = normalizeArtifactPath(input.target);
      if (targets.has(target)) violation(`Duplicate artifact input target ${target}`);
      targets.add(target);
      const destination = path.join(inputRoot, ...target.split('/'));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const remaining = Math.min(limits.inputFileBytes, limits.inputBytes - total);
      const written = await stageInput(input, destination, remaining, signal);
      total += written;
    }
    const outputs: Array<{ path: string; maxBytes: number; required: boolean }> = [];
    let declaredBytes = 0;
    let uniformOutputBytes: number | undefined;
    for (const output of requestedOutputs) {
      const outputPath = normalizeArtifactPath(output.path);
      const maxBytes = output.maxBytes ?? limits.outputFileBytes;
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > limits.outputFileBytes) {
        violation(`Artifact output ${outputPath} has an invalid maximum`);
      }
      uniformOutputBytes ??= maxBytes;
      if (maxBytes !== uniformOutputBytes) {
        violation('Declared outputs must use one uniform hard maximum');
      }
      declaredBytes += maxBytes;
      if (declaredBytes > limits.outputBytes) {
        violation('Declared outputs exceed the aggregate output limit');
      }
      if (targets.has(`output:${outputPath}`)) violation(`Duplicate artifact output ${outputPath}`);
      targets.add(`output:${outputPath}`);
      const destination = path.join(outputRoot, ...outputPath.split('/'));
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const handle = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.close();
      outputs.push(Object.freeze({ path: outputPath, maxBytes, required: output.required ?? true }));
    }
    return Object.freeze({ path: workspace, limits, outputs: Object.freeze(outputs) });
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

export async function collectArtifacts(
  workspace: PreparedWorkspace,
  manifest: readonly ArtifactManifestEntry[],
  signal?: AbortSignal,
): Promise<readonly Readonly<OutputArtifact>[]> {
  if (manifest.length > workspace.limits.outputFiles) {
    violation('Supervisor returned too many artifacts');
  }
  const outputRoot = path.join(workspace.path, 'output');
  const artifacts: OutputArtifact[] = [];
  const paths = new Set<string>();
  const declared = new Map(workspace.outputs.map((output) => [output.path, output.maxBytes]));
  let total = 0;
  for (const entry of manifest) {
    const relative = normalizeArtifactPath(entry.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      violation('Supervisor returned an invalid artifact manifest');
    }
    if (paths.has(relative)) violation(`Supervisor returned duplicate artifact ${relative}`);
    const declaredMaximum = declared.get(relative);
    if (declaredMaximum === undefined) violation(`Supervisor returned undeclared artifact ${relative}`);
    paths.add(relative);
    total += entry.size;
    if (
      entry.size > declaredMaximum
      || total > workspace.limits.outputBytes
    ) {
      violation('Supervisor artifact manifest exceeds its limits');
    }
    const filename = path.join(outputRoot, ...relative.split('/'));
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== entry.size) {
        violation(`Artifact ${relative} changed after validation`);
      }
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < entry.size) {
        throwIfAborted(signal);
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, entry.size - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (bytesRead === 0) violation(`Artifact ${relative} changed while it was read`);
        chunks.push(chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const data = Buffer.concat(chunks, entry.size);
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (sha256 !== entry.sha256) violation(`Artifact ${relative} failed integrity validation`);
      artifacts.push(Object.freeze({ path: relative, size: entry.size, sha256, data }));
    } finally {
      await handle.close();
    }
  }
  return Object.freeze(artifacts);
}

export async function removeWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
}

export async function removeWorkspaceRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

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

export async function reserveWorkspaceCapacity(
  root: string,
  limits: Readonly<ArtifactLimits>,
): Promise<Readonly<{ requested: bigint; usable: bigint }>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const filesystem = await statfs(root, { bigint: true });
  const available = filesystem.bavail * filesystem.bsize;
  const requested = BigInt(limits.inputBytes) + BigInt(limits.outputBytes);
  const usable = available * 80n / 100n;
  if (requested > usable) {
    throw new SandboxError('CAPACITY_EXCEEDED', 'Artifact workspace has insufficient free space');
  }
  return Object.freeze({ requested, usable });
}

async function stageInput(
  input: ArtifactInput,
  destination: string,
  remaining: number,
  signal?: AbortSignal,
): Promise<number> {
  if ('sourcePath' in input) {
    const source = await open(input.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await source.stat();
      if (!info.isFile() || info.nlink !== 1) violation('Artifact source must be a regular single-link file');
      if (info.size > remaining) violation('Artifact input bytes exceed their limit');
      const destinationHandle = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        let written = 0;
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (written < info.size) {
          throwIfAborted(signal);
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, info.size - written));
          if (bytesRead === 0) violation('Artifact source changed while it was staged');
          await writeAll(destinationHandle, buffer.subarray(0, bytesRead));
          written += bytesRead;
        }
        const finalInfo = await source.stat();
        if (finalInfo.size !== info.size || finalInfo.mtimeMs !== info.mtimeMs) {
          violation('Artifact source changed while it was staged');
        }
        return written;
      } finally {
        await destinationHandle.close();
      }
    } finally {
      await source.close();
    }
  }
  const handle = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let written = 0;
  try {
    const producerSignal = new AbortController();
    const chunks: AsyncIterable<Uint8Array | string> = 'data' in input
      ? (async function* () { yield input.data; })()
      : 'stream' in input
        ? input.stream
        : input.iterable(producerSignal.signal);
    const iterator = chunks[Symbol.asyncIterator]();
    let completed = false;
    try {
      while (true) {
        const next = await nextWithAbort(iterator.next(), signal);
        if (next.done) {
          completed = true;
          break;
        }
        const bytes = Buffer.from(next.value);
        if (written + bytes.length > remaining) violation('Artifact input bytes exceed their limit');
        await writeAll(handle, bytes);
        written += bytes.length;
      }
    } finally {
      if (!completed) {
        producerSignal.abort();
        if ('stream' in input) input.stream.destroy();
        void iterator.return?.().catch(() => undefined);
      }
    }
    return written;
  } finally {
    await handle.close();
  }
}

function normalizeArtifactPath(value: string): string {
  if (!value || value.length > 1024 || value.includes('\0') || value.includes('\\')) {
    violation('Artifact path is invalid');
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === '.'
    || normalized.startsWith('/')
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    violation('Artifact path must be a normalized relative POSIX path');
  }
  return normalized;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SandboxError('CANCELLED', 'Sandbox request was cancelled');
}

async function nextWithAbort<T>(
  next: Promise<IteratorResult<T>>,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  if (!signal) return next;
  throwIfAborted(signal);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new SandboxError('CANCELLED', 'Sandbox request was cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([next, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten === 0) {
      throw new SandboxError('INTERNAL_ERROR', 'Artifact staging write made no progress');
    }
    offset += bytesWritten;
  }
}

function violation(message: string): never {
  throw new SandboxError('POLICY_VIOLATION', message);
}
