import { ID_PATTERN, policyError } from '../errors.js';
import { validatePartialLimits } from '../policy/resolve.js';
import type { ProfileDefinition, ResolvedProfile } from '../types.js';

export class ProfileRegistry {
  private readonly profiles = new Map<string, Readonly<ResolvedProfile>>();
  private locked = false;

  lock(): void {
    this.locked = true;
  }

  define(name: string, definition: ProfileDefinition): Readonly<ResolvedProfile> {
    if (this.locked) {
      throw policyError('Profiles must be defined before the supervisor starts');
    }
    if (!ID_PATTERN.test(name) || this.profiles.has(name)) {
      throw policyError('Profile name is invalid or already used', { name });
    }
    const base = definition.extends ? this.profiles.get(definition.extends) : undefined;
    if (definition.extends && !base) {
      throw policyError('Base profile is not registered', { base: definition.extends });
    }
    // Shape and value checks happen here; operator ceilings still apply per run.
    validatePartialLimits(`profiles.${name}.limits`, definition.limits);
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
      throw policyError('Profile is not registered', { name });
    }
    return profile;
  }
}
