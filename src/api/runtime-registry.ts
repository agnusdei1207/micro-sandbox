import path from 'node:path';
import { SandboxError } from '../errors.js';
import type { RuntimeDefinition } from '../types.js';

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, Readonly<RuntimeDefinition>>();

  register(definition: RuntimeDefinition): Readonly<RuntimeDefinition> {
    if (!ID_PATTERN.test(definition.id)) {
      throw policyError('Runtime ID is invalid', { id: definition.id });
    }
    if (this.runtimes.has(definition.id)) {
      throw policyError('Runtime ID is already registered', { id: definition.id });
    }
    if (!DIGEST_PATTERN.test(definition.digest)) {
      throw policyError('Runtime digest must be a lowercase SHA-256 digest', {
        digest: definition.digest,
      });
    }
    if (!path.isAbsolute(definition.rootfs)) {
      throw policyError('Runtime rootfs must be an absolute host path');
    }
    if (!path.posix.isAbsolute(definition.entrypoint)) {
      throw policyError('Runtime entrypoint must be an absolute guest path');
    }

    const runtime = Object.freeze({
      ...definition,
      environment: Object.freeze([...(definition.environment ?? [])]),
    });
    this.runtimes.set(runtime.id, runtime);
    return runtime;
  }

  get(id: string): Readonly<RuntimeDefinition> {
    const runtime = this.runtimes.get(id);
    if (!runtime) throw policyError('Runtime is not registered', { id });
    return runtime;
  }

  entries(): readonly Readonly<RuntimeDefinition>[] {
    return Object.freeze([...this.runtimes.values()]);
  }
}

function policyError(message: string, details?: Record<string, unknown>): SandboxError {
  return new SandboxError('POLICY_VIOLATION', message, details);
}
