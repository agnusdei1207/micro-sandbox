import { SandboxError } from '../errors.js';
import type { ProfileDefinition, ResolvedProfile } from '../types.js';

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/;

export class ProfileRegistry {
  private readonly profiles = new Map<string, Readonly<ResolvedProfile>>();

  define(name: string, definition: ProfileDefinition): Readonly<ResolvedProfile> {
    if (!ID_PATTERN.test(name) || this.profiles.has(name)) {
      throw new SandboxError('POLICY_VIOLATION', 'Profile name is invalid or already used', {
        name,
      });
    }
    const base = definition.extends ? this.profiles.get(definition.extends) : undefined;
    if (definition.extends && !base) {
      throw new SandboxError('POLICY_VIOLATION', 'Base profile is not registered', {
        base: definition.extends,
      });
    }
    const profile = Object.freeze({
      name,
      limits: Object.freeze({ ...base?.limits, ...definition.limits }),
    });
    this.profiles.set(name, profile);
    return profile;
  }

  get(name: string): Readonly<ResolvedProfile> {
    const profile = this.profiles.get(name);
    if (!profile) {
      throw new SandboxError('POLICY_VIOLATION', 'Profile is not registered', { name });
    }
    return profile;
  }
}
