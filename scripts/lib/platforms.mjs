import { readFileSync } from 'node:fs';

// Multi-architecture index digests from `docker buildx imagetools inspect <image>`.
// Update each tag and digest together.
export const IMAGES = Object.freeze({
  rustAlpine: 'rust:1.97.1-alpine@sha256:3c38f3f82c2f3d73da3b38e18d279393a04cb43ddded0e35088a8c3324d40900',
  rustBookworm: 'rust:1.97.1-bookworm@sha256:0e2bcaef56d041a486784e54104a81aebe0da44bd03019bd70bc0401e42e4a97',
  nodeBookworm: 'node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059',
});

export const PLATFORMS = Object.freeze([
  Object.freeze({
    arch: 'x64',
    dockerPlatform: 'linux/amd64',
    name: 'micro-sandbox-linux-x64',
    directory: 'npm/linux-x64',
    elfMachine: 0x3e,
  }),
  Object.freeze({
    arch: 'arm64',
    dockerPlatform: 'linux/arm64',
    name: 'micro-sandbox-linux-arm64',
    directory: 'npm/linux-arm64',
    elfMachine: 0xb7,
  }),
]);

export const MAIN_PACKAGE = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).name;

// The release workflow uploads the main package tarball only from this job.
export const MAIN_ARTIFACT_ARCH = 'x64';

export function platformFor(arch, label = 'platform') {
  const platform = PLATFORMS.find((candidate) => candidate.arch === arch);
  if (!platform) throw new Error(`Unsupported ${label} architecture ${JSON.stringify(arch)}`);
  return platform;
}

// Returns the `--current=` architecture, or `fallback` when the flag is absent.
// An undefined result means every platform.
export function parseCurrentArch(argv, { fallback, label = 'platform' } = {}) {
  const argument = argv.find((value) => value.startsWith('--current='));
  const value = argument === undefined ? fallback : argument.slice('--current='.length);
  if (value === undefined) return undefined;
  return platformFor(value, label).arch;
}

export function selectedPlatforms(current) {
  return PLATFORMS.filter((platform) => current === undefined || platform.arch === current);
}
