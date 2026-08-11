import path from 'node:path';
import { SandboxError } from '../errors.js';

const RESERVED_ROOTS = ['/dev', '/proc', '/sys'];

export function normalizeGuestPath(candidate: string, allowRoot = false): string {
  if (
    candidate.length === 0 ||
    candidate.includes('\0') ||
    candidate.includes('\\') ||
    !candidate.startsWith('/') ||
    candidate.split('/').includes('..')
  ) {
    throw invalidPath(candidate);
  }

  const normalized = path.posix.normalize(candidate);
  if (
    (!allowRoot && normalized === '/') ||
    RESERVED_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))
  ) {
    throw invalidPath(candidate);
  }
  return normalized;
}

function invalidPath(candidate: string): SandboxError {
  return new SandboxError('POLICY_VIOLATION', 'Guest path is not allowed', {
    path: candidate,
  });
}
