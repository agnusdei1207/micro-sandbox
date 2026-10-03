import path from 'node:path';
import { ID_PATTERN, policyError } from '../errors.js';
import { normalizeGuestPath } from '../policy/paths.js';
import type { RuntimeDefinition } from '../types.js';

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, Readonly<RuntimeDefinition>>();
  private locked = false;

  lock(): void {
    this.locked = true;
  }

  register(definition: RuntimeDefinition): Readonly<RuntimeDefinition> {
    if (this.locked) throw policyError('Runtimes must be registered before the supervisor starts');
    if (typeof definition.id !== 'string' || !ID_PATTERN.test(definition.id)) {
      throw policyError('Runtime ID is invalid', { id: definition.id });
    }
    if (this.runtimes.has(definition.id)) {
      throw policyError('Runtime ID is already registered', { id: definition.id });
    }
    if (typeof definition.rootfs !== 'string' || !path.isAbsolute(definition.rootfs)) {
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
