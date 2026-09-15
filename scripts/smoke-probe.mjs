export function createInstalledPackageProbe(arch, version, expectedSha256) {
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error(`Unsupported smoke probe architecture ${arch}`);
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 ?? '')) {
    throw new Error('Expected native SHA-256 is invalid');
  }
  const mainPackage = '@agnusdei12071207/micro-sandbox';
  const nativePackage = `micro-sandbox-linux-${arch}`;
  return `
const { spawnSync } = await import('node:child_process');
const { createHash } = await import('node:crypto');
const { readFileSync } = await import('node:fs');
const { createRequire } = await import('node:module');
const mainUrl = import.meta.resolve(${JSON.stringify(mainPackage)});
const packageRequire = createRequire(mainUrl);
const binary = packageRequire.resolve(${JSON.stringify(`${nativePackage}/bin/micro-sandbox`)});
const installedSha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
if (installedSha256 !== ${JSON.stringify(expectedSha256)}) {
  throw new Error('installed native executable does not match the built binary');
}
const native = spawnSync(binary, ['--version'], { encoding: 'utf8', shell: false });
if (native.error) throw native.error;
if (native.status !== 0) throw new Error('native executable failed: ' + (native.stderr || native.status));
if (native.stdout.trim() !== ${JSON.stringify(`micro-sandbox ${version}`)}) {
  throw new Error('native executable version mismatch: ' + native.stdout.trim());
}
const api = await import(mainUrl);
if (typeof api.createSandbox !== 'function') throw new Error('createSandbox export is unavailable');
`;
}
