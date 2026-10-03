import path from 'node:path';
import { policyError } from '../errors.js';

const RESERVED_ROOTS = ['/dev', '/proc', '/sys'];

export function normalizeGuestPath(candidate: string, allowRoot = false): string {
  if (
    typeof candidate !== 'string' ||
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

function invalidPath(candidate: unknown): Error {
  return policyError('Guest path is not allowed', { path: candidate });
}
