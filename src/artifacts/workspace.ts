import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  policyError,
  raceAbort,
  SandboxError,
  throwIfAborted,
} from '../errors.js';
import type {
  ArtifactInput,
  ArtifactLimits,
  ArtifactRequest,
  OutputArtifact,
} from '../types.js';

export interface ArtifactManifestEntry {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface DeclaredOutput {
  readonly path: string;
  readonly maxBytes: number;
  readonly required: boolean;
}

type InputSource =
  | { readonly kind: 'data'; readonly data: Uint8Array | string }
  | { readonly kind: 'sourcePath'; readonly sourcePath: string }
  | {
      readonly kind: 'stream';
      readonly stream: AsyncIterable<unknown> & { destroy(error?: Error): void };
    }
  | { readonly kind: 'iterable'; readonly iterable: (signal: AbortSignal) => AsyncIterable<unknown> };

export interface PlannedInput {
  readonly target: string;
  readonly source: InputSource;
}

/** A validated, normalized snapshot of an artifact request. Nothing has touched disk. */
export interface ArtifactPlan {
  readonly limits: Readonly<ArtifactLimits>;
  readonly inputs: readonly PlannedInput[];
  readonly outputs: readonly Readonly<DeclaredOutput>[];
}

/** Sent to the native supervisor as the run's `workspace` (native `WorkspaceSpec`). */
export interface PreparedWorkspace {
  readonly path: string;
  readonly limits: Readonly<ArtifactLimits>;
  readonly outputs: readonly Readonly<DeclaredOutput>[];
}

export function defaultWorkspaceRoot(): string {
  return path.join(tmpdir(), `micro-sandbox-${process.pid}-${randomUUID()}`);
}

/**
 * Validates and normalizes an artifact request without performing I/O. Rejects
 * malformed sources, invalid or duplicate paths, and paths where one would have to be
 * both a file and a directory (`a` and `a/b`).
 */
export function planArtifacts(
  request: ArtifactRequest,
  limits: Readonly<ArtifactLimits>,
): ArtifactPlan {
  if (!request || typeof request !== 'object') throw policyError('Artifact request must be an object');
  const requestedInputs = optionalArray(request.inputs, 'Artifact inputs');
  const requestedOutputs = optionalArray(request.outputs, 'Artifact outputs');
  if (requestedInputs.length > limits.inputFiles) {
    throw policyError('Artifact input file count exceeds its limit');
  }
  if (requestedOutputs.length > limits.outputFiles) {
    throw policyError('Artifact output file count is invalid');
  }

  const inputTree = new PathTree('input');
  const inputs = requestedInputs.map((input): PlannedInput => {
    if (!input || typeof input !== 'object') throw policyError('Artifact input must be an object');
    const source = inputSource(input);
    return Object.freeze({ target: inputTree.add(input.target), source });
  });

  const outputTree = new PathTree('output');
  const outputs: Readonly<DeclaredOutput>[] = [];
  let declaredBytes = 0;
  let uniformOutputBytes: number | undefined;
  for (const output of requestedOutputs) {
    if (!output || typeof output !== 'object') throw policyError('Artifact output must be an object');
    const outputPath = normalizeArtifactPath(output.path);
    const maxBytes = output.maxBytes ?? limits.outputFileBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > limits.outputFileBytes) {
      throw policyError(`Artifact output ${outputPath} has an invalid maximum`);
    }
    uniformOutputBytes ??= maxBytes;
    if (maxBytes !== uniformOutputBytes) {
      throw policyError('Declared outputs must use one uniform hard maximum');
    }
    declaredBytes += maxBytes;
    if (declaredBytes > limits.outputBytes) {
      throw policyError('Declared outputs exceed the aggregate output limit');
    }
    if (output.required !== undefined && typeof output.required !== 'boolean') {
      throw policyError(`Artifact output ${outputPath} has an invalid required flag`);
    }
    outputTree.add(outputPath);
    outputs.push(Object.freeze({ path: outputPath, maxBytes, required: output.required ?? true }));
  }
  return Object.freeze({
    limits,
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
  });
}

export async function prepareWorkspace(
  root: string,
  plan: ArtifactPlan,
  signal?: AbortSignal,
): Promise<PreparedWorkspace> {
  const workspace = path.join(root, `job-${randomUUID()}`);
  const inputRoot = path.join(workspace, 'input');
  const outputRoot = path.join(workspace, 'output');
  const { limits } = plan;
  let total = 0;
  try {
    await hostStep(mkdir(inputRoot, { recursive: true, mode: 0o700 }));
    await hostStep(mkdir(outputRoot, { mode: 0o700 }));
    for (const input of plan.inputs) {
      throwIfAborted(signal);
      const destination = path.join(inputRoot, ...input.target.split('/'));
      await hostStep(mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }));
      const remaining = Math.min(limits.inputFileBytes, limits.inputBytes - total);
      total += await stageInput(input, destination, remaining, signal);
    }
    for (const output of plan.outputs) {
      const destination = path.join(outputRoot, ...output.path.split('/'));
      await hostStep(mkdir(path.dirname(destination), { recursive: true, mode: 0o700 }));
      const handle = await hostStep(open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      ));
      await handle.close();
    }
    return Object.freeze({ path: workspace, limits, outputs: plan.outputs });
  } catch (error) {
    try {
      await rm(workspace, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Artifact staging failed and its workspace could not be removed',
      );
    }
    throw error;
  }
}

export async function collectArtifacts(
  workspace: PreparedWorkspace,
  manifest: readonly unknown[],
  signal?: AbortSignal,
): Promise<readonly Readonly<OutputArtifact>[]> {
  if (manifest.length > workspace.limits.outputFiles) {
    throw policyError('Supervisor returned too many artifacts');
  }
  const outputRoot = path.join(workspace.path, 'output');
  const artifacts: OutputArtifact[] = [];
  const paths = new Set<string>();
  const declared = new Map(workspace.outputs.map((output) => [output.path, output.maxBytes]));
  let total = 0;
  for (const entry of manifest) {
    const { path: entryPath, size, sha256: expected } = manifestEntry(entry);
    const relative = normalizeArtifactPath(entryPath);
    if (paths.has(relative)) throw policyError(`Supervisor returned duplicate artifact ${relative}`);
    const declaredMaximum = declared.get(relative);
    if (declaredMaximum === undefined) {
      throw policyError(`Supervisor returned undeclared artifact ${relative}`);
    }
    paths.add(relative);
    total += size;
    if (size > declaredMaximum || total > workspace.limits.outputBytes) {
      throw policyError('Supervisor artifact manifest exceeds its limits');
    }
    const filename = path.join(outputRoot, ...relative.split('/'));
    const handle = await guestStep(
      open(filename, constants.O_RDONLY | constants.O_NOFOLLOW),
      `Artifact ${relative} cannot be opened as a regular file`,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== size) {
        throw policyError(`Artifact ${relative} changed after validation`);
      }
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < size) {
        throwIfAborted(signal);
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset));
        const { bytesRead } = await guestStep(
          handle.read(chunk, 0, chunk.length, offset),
          `Artifact ${relative} cannot be read`,
        );
        if (bytesRead === 0) throw policyError(`Artifact ${relative} changed while it was read`);
        chunks.push(chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
      const data = Buffer.concat(chunks, size);
      const sha256 = createHash('sha256').update(data).digest('hex');
      if (sha256 !== expected) throw policyError(`Artifact ${relative} failed integrity validation`);
      artifacts.push(Object.freeze({ path: relative, size, sha256, data }));
    } finally {
      await handle.close();
    }
  }
  for (const output of workspace.outputs) {
    if (output.required && !paths.has(output.path)) {
      throw policyError(`Supervisor omitted required artifact ${output.path}`);
    }
  }
  return Object.freeze(artifacts);
}

export async function removeWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
}

export async function reserveWorkspaceCapacity(
  root: string,
  limits: Readonly<ArtifactLimits>,
): Promise<Readonly<{ requested: bigint; usable: bigint }>> {
  await hostStep(mkdir(root, { recursive: true, mode: 0o700 }));
  const filesystem = await hostStep(statfs(root, { bigint: true }));
  const available = filesystem.bavail * filesystem.bsize;
  const requested = BigInt(limits.inputBytes) + BigInt(limits.outputBytes);
  const usable = available * 80n / 100n;
  if (requested > usable) {
    throw new SandboxError('CAPACITY_EXCEEDED', 'Artifact workspace has insufficient free space');
  }
  return Object.freeze({ requested, usable });
}

async function stageInput(
  input: PlannedInput,
  destination: string,
  remaining: number,
  signal?: AbortSignal,
): Promise<number> {
  const { source } = input;
  if (source.kind === 'sourcePath') {
    const file = await guestStep(
      open(source.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW),
      `Artifact source for ${input.target} cannot be opened as a regular file`,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) {
        throw policyError('Artifact source must be a regular single-link file');
      }
      if (info.size > remaining) throw policyError('Artifact input bytes exceed their limit');
      const destinationHandle = await openDestination(destination);
      try {
        let written = 0;
        const buffer = Buffer.allocUnsafe(64 * 1024);
        while (written < info.size) {
          throwIfAborted(signal);
          const { bytesRead } = await guestStep(
            file.read(buffer, 0, Math.min(buffer.length, info.size - written)),
            `Artifact source for ${input.target} cannot be read`,
          );
          if (bytesRead === 0) throw policyError('Artifact source changed while it was staged');
          await writeAll(destinationHandle, buffer.subarray(0, bytesRead));
          written += bytesRead;
        }
        const finalInfo = await file.stat();
        if (finalInfo.size !== info.size || finalInfo.mtimeMs !== info.mtimeMs) {
          throw policyError('Artifact source changed while it was staged');
        }
        return written;
      } finally {
        await destinationHandle.close();
      }
    } finally {
      await file.close();
    }
  }
  const handle = await openDestination(destination);
  let written = 0;
  try {
    const producerSignal = new AbortController();
    const chunks: AsyncIterable<unknown> = source.kind === 'data'
      ? (async function* () { yield source.data; })()
      : source.kind === 'stream'
        ? source.stream
        : source.iterable(producerSignal.signal);
    if (!chunks || typeof chunks[Symbol.asyncIterator] !== 'function') {
      throw policyError(`Artifact input ${input.target} did not produce an async iterable`);
    }
    const iterator = chunks[Symbol.asyncIterator]();
    let completed = false;
    try {
      while (true) {
        const next = await raceAbort(iterator.next(), signal);
        if (next.done) {
          completed = true;
          break;
        }
        const bytes = chunkBytes(next.value, input.target);
        if (written + bytes.length > remaining) throw policyError('Artifact input bytes exceed their limit');
        await writeAll(handle, bytes);
        written += bytes.length;
      }
    } finally {
      if (!completed) {
        producerSignal.abort();
        if (source.kind === 'stream') source.stream.destroy();
        void iterator.return?.().catch(() => undefined);
      }
    }
    return written;
  } finally {
    await handle.close();
  }
}

function inputSource(input: ArtifactInput): InputSource {
  const candidate = input as Partial<Record<'data' | 'sourcePath' | 'stream' | 'iterable', unknown>>;
  const present = (['data', 'sourcePath', 'stream', 'iterable'] as const)
    .filter((key) => candidate[key] !== undefined);
  if (present.length !== 1) throw policyError('Artifact input must define exactly one source');
  const { data, sourcePath, stream, iterable } = candidate;
  switch (present[0]) {
    case 'data':
      if (typeof data === 'string' || data instanceof Uint8Array) return { kind: 'data', data };
      break;
    case 'sourcePath':
      if (typeof sourcePath === 'string' && sourcePath.length > 0 && !sourcePath.includes('\0')) {
        return { kind: 'sourcePath', sourcePath };
      }
      break;
    case 'stream':
      if (
        stream !== null && typeof stream === 'object'
        && typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function'
        && typeof (stream as { destroy?: unknown }).destroy === 'function'
      ) {
        return {
          kind: 'stream',
          stream: stream as AsyncIterable<unknown> & { destroy(error?: Error): void },
        };
      }
      break;
    case 'iterable':
      if (typeof iterable === 'function') {
        return {
          kind: 'iterable',
          iterable: iterable as (signal: AbortSignal) => AsyncIterable<unknown>,
        };
      }
      break;
  }
  throw policyError(`Artifact input ${String(present[0])} source has an invalid type`);
}

function chunkBytes(value: unknown, target: string): Uint8Array {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof Uint8Array) return value;
  throw policyError(`Artifact input ${target} produced a chunk that is not a string or Uint8Array`);
}

function manifestEntry(entry: unknown): ArtifactManifestEntry {
  if (!entry || typeof entry !== 'object') {
    throw policyError('Supervisor returned an invalid artifact manifest');
  }
  const { path: entryPath, size, sha256 } = entry as Record<string, unknown>;
  if (
    typeof entryPath !== 'string'
    || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0
    || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    throw policyError('Supervisor returned an invalid artifact manifest');
  }
  return { path: entryPath, size, sha256 };
}

function optionalArray<T>(value: readonly T[] | undefined, label: string): readonly T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw policyError(`${label} must be an array`);
  return value;
}

/** Tracks normalized relative paths so no file is also another path's directory. */
class PathTree {
  private readonly files = new Set<string>();
  private readonly directories = new Set<string>();

  constructor(private readonly label: string) {}

  add(value: unknown): string {
    const normalized = normalizeArtifactPath(value);
    if (this.files.has(normalized)) {
      throw policyError(`Duplicate artifact ${this.label} ${normalized}`);
    }
    if (this.directories.has(normalized)) {
      throw policyError(`Artifact ${this.label} ${normalized} overlaps another ${this.label}`);
    }
    const parents: string[] = [];
    for (let index = normalized.indexOf('/'); index !== -1; index = normalized.indexOf('/', index + 1)) {
      const parent = normalized.slice(0, index);
      if (this.files.has(parent)) {
        throw policyError(`Artifact ${this.label} ${normalized} overlaps another ${this.label}`);
      }
      parents.push(parent);
    }
    this.files.add(normalized);
    for (const parent of parents) this.directories.add(parent);
    return normalized;
  }
}

function normalizeArtifactPath(value: unknown): string {
  if (
    typeof value !== 'string' || !value || value.length > 1024
    || value.includes('\0') || value.includes('\\')
  ) {
    throw policyError('Artifact path is invalid');
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === '.'
    || normalized.startsWith('/')
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    throw policyError('Artifact path must be a normalized relative POSIX path');
  }
  return normalized;
}

function openDestination(destination: string) {
  return hostStep(open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  ));
}

/**
 * Host-side workspace I/O (our own directories). Failures here are environmental, so
 * they surface as INTERNAL_ERROR with the original error as `cause`.
 */
async function hostStep<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    if (cause instanceof SandboxError) throw cause;
    throw new SandboxError('INTERNAL_ERROR', 'Artifact workspace I/O failed', undefined, { cause });
  }
}

/**
 * I/O on caller-supplied sources or guest-produced outputs. A missing file, symlink, or
 * unreadable entry is a policy failure of that content, reported with its cause.
 */
async function guestStep<T>(operation: Promise<T>, message: string): Promise<T> {
  try {
    return await operation;
  } catch (cause) {
    if (cause instanceof SandboxError) throw cause;
    throw policyError(message, undefined, cause);
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await hostStep(handle.write(bytes, offset, bytes.length - offset));
    if (bytesWritten === 0) {
      throw new SandboxError('INTERNAL_ERROR', 'Artifact staging write made no progress');
    }
    offset += bytesWritten;
  }
}
