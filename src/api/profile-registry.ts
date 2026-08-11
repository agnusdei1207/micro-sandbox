import { SandboxError } from '../errors.js';
import type { ProfileDefinition, ResolvedProfile } from '../types.js';

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62})$/;
const BUILTIN_NAMES = ['strict', 'interpreted-code', 'compilation', 'media', 'sanitize'];

export class ProfileRegistry {
  private readonly profiles = new Map<string, Readonly<ResolvedProfile>>();

  constructor() {
    for (const name of BUILTIN_NAMES) {
      this.profiles.set(
        name,
        Object.freeze({
          name,
          base: name,
          limits: Object.freeze({}),
          addSyscalls: Object.freeze([]),
        }),
      );
    }
  }

  define(name: string, definition: ProfileDefinition): Readonly<ResolvedProfile> {
    if (!ID_PATTERN.test(name) || this.profiles.has(name)) {
      throw new SandboxError('POLICY_VIOLATION', 'Profile name is invalid or already used', {
        name,
      });
    }
    const base = this.profiles.get(definition.base);
    if (!base) {
      throw new SandboxError('POLICY_VIOLATION', 'Base profile is not registered', {
        base: definition.base,
      });
    }
    const profile = Object.freeze({
      name,
      base: definition.base,
      limits: Object.freeze({ ...base.limits, ...definition.limits }),
      addSyscalls: Object.freeze([
        ...new Set([...base.addSyscalls, ...(definition.addSyscalls ?? [])]),
      ]),
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
