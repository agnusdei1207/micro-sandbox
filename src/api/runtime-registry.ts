import path from 'node:path';
import { SandboxError } from '../errors.js';
import { normalizeGuestPath } from '../policy/paths.js';
import type { RuntimeDefinition } from '../types.js';

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/;

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, Readonly<RuntimeDefinition>>();
  private locked = false;

  lock(): void {
    this.locked = true;
  }

  register(definition: RuntimeDefinition): Readonly<RuntimeDefinition> {
    if (this.locked) throw policyError('Runtimes must be registered before the supervisor starts');
    if (!ID_PATTERN.test(definition.id)) {
      throw policyError('Runtime ID is invalid', { id: definition.id });
    }
    if (this.runtimes.has(definition.id)) {
      throw policyError('Runtime ID is already registered', { id: definition.id });
    }
    if (!path.isAbsolute(definition.rootfs)) {
      throw policyError('Runtime rootfs must be an absolute host path');
    }
    normalizeGuestPath(definition.entrypoint);

    const runtime = Object.freeze({
      ...definition,
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
