import { spawnSync } from 'node:child_process';
import process from 'node:process';

const mount = `${process.cwd()}:/work`;
const current = process.argv.find((value) => value.startsWith('--current='))?.split('=')[1];
const platforms = [
  { npmArch: 'x64', dockerArch: 'amd64' },
  { npmArch: 'arm64', dockerArch: 'arm64' },
];
for (const platform of platforms) {
  if (current && current !== platform.npmArch) continue;
  run([
    'run', '--rm', '--platform', `linux/${platform.dockerArch}`, '-v', mount, '-w', '/work',
    'rust:1.97.1-alpine', 'sh', '-c',
    `CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/target cargo build --locked --release --manifest-path native/Cargo.toml && mkdir -p npm/linux-${platform.npmArch}/bin && cp /tmp/target/release/micro-sandbox npm/linux-${platform.npmArch}/bin/micro-sandbox && chmod 755 npm/linux-${platform.npmArch}/bin/micro-sandbox`,
  ]);
}

function run(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
