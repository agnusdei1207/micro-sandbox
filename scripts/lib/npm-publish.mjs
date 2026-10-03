import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

export function tarballIntegrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

// `npm(args)` returns a captured spawnSync-like result and does not throw on a
// non-zero status. An existing registry version is accepted only when its
// dist.integrity equals the local tarball's integrity.
export function publishUnlessPresent({ name, version, tarball, provenance = false, npm, log = console.log }) {
  const spec = `${name}@${version}`;
  const local = tarballIntegrity(readFileSync(tarball));
  const existing = registryIntegrity(npm, spec);
  if (existing !== undefined) {
    assertSameIntegrity(spec, existing, local);
    log(`${spec} is already published with matching integrity`);
    return 'present';
  }
  const result = npm(['publish', tarball, '--access', 'public', ...(provenance ? ['--provenance'] : [])]);
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status === 0) return 'published';
  if (alreadyPublished(result)) {
    const raced = registryIntegrity(npm, spec);
    if (raced === undefined) throw new Error(`${spec} was reported as published but has no registry integrity`);
    assertSameIntegrity(spec, raced, local);
    log(`${spec} was published concurrently with matching integrity`);
    return 'present';
  }
  throw new Error(`npm publish ${spec} failed with status ${result.status}`);
}

export function registryIntegrity(npm, spec) {
  const result = npm(['view', spec, 'dist.integrity', '--json']);
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) {
    if (/\bE404\b/.test(output)) return undefined;
    throw new Error(`npm view ${spec} failed with status ${result.status}: ${output.trim()}`);
  }
  const text = (result.stdout ?? '').trim();
  if (text === '') return undefined;
  const value = JSON.parse(text);
  if (typeof value !== 'string' || !value.startsWith('sha512-')) {
    throw new Error(`Registry integrity for ${spec} is invalid: ${text}`);
  }
  return value;
}

function assertSameIntegrity(spec, registry, local) {
  if (registry !== local) {
    throw new Error(
      `${spec} is already published with different contents (registry ${registry}, local ${local}); `
      + 'a published version cannot be replaced, so release a new version',
    );
  }
}

function alreadyPublished(result) {
  return /previously published versions|cannot publish over/i.test(
    `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  );
}
