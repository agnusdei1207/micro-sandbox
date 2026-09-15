export function packageTarballName(name, version) {
  const packageSlug = name.startsWith('@')
    ? name.slice(1).replaceAll('/', '-')
    : name;
  return `${packageSlug}-${version}.tgz`;
}

export function requirePackageTarball(files, name, version) {
  const expected = packageTarballName(name, version);
  if (!files.includes(expected)) {
    throw new Error(`Missing tarball for ${name}@${version}`);
  }
  return expected;
}

export function verifyOptionalDependencyLock(lock, name, version) {
  const packages = lock?.packages;
  if (!packages || typeof packages !== 'object') {
    throw new Error('Lockfile packages map is missing');
  }
  const rootVersion = packages['']?.optionalDependencies?.[name];
  if (rootVersion !== version) {
    throw new Error(`Lockfile requirement for ${name} must equal ${version}`);
  }
  const entry = packages[`node_modules/${name}`];
  if (!entry || entry.optional !== true) {
    throw new Error(`Lockfile optional placeholder for ${name}@${version} is missing`);
  }

  const metadata = [entry.version, entry.resolved, entry.integrity];
  if (metadata.every((value) => value === undefined)) return 'unpublished';
  if (metadata.some((value) => value === undefined)) {
    throw new Error(`Lockfile entry for ${name}@${version} has incomplete registry metadata`);
  }
  if (entry.version !== version) {
    throw new Error(`Lockfile version for ${name} must equal ${version}`);
  }
  if (!/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved)) {
    throw new Error(`Lockfile registry URL for ${name}@${version} is invalid`);
  }
  if (!/^sha512-/.test(entry.integrity)) {
    throw new Error(`Lockfile integrity for ${name}@${version} is invalid`);
  }
  return 'published';
}
