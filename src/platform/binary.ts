import { createRequire } from 'node:module';
import { SandboxError } from '../errors.js';

interface BinaryResolutionOptions {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly override?: string;
}

const PLATFORM_PACKAGES: Readonly<Record<string, string>> = Object.freeze({
  'linux:x64': 'micro-sandbox-linux-x64',
  'linux:arm64': 'micro-sandbox-linux-arm64',
});

export function resolveSupervisorBinary(options: BinaryResolutionOptions = {}): string {
  if (options.override) return options.override;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const packageName = PLATFORM_PACKAGES[`${platform}:${arch}`];
  if (!packageName) {
    throw new SandboxError(
      'UNSUPPORTED_PLATFORM',
      `micro-sandbox supports Linux x64 and arm64; received ${platform} ${arch}`,
      { platform, arch },
    );
  }

  try {
    return createRequire(import.meta.url).resolve(`${packageName}/bin/micro-sandbox`);
  } catch (cause) {
    throw new SandboxError(
      'SUPERVISOR_UNAVAILABLE',
      `Platform package ${packageName} is not installed`,
      { packageName },
      { cause },
    );
  }
}
