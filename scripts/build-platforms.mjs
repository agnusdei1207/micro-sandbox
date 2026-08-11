import { spawnSync } from 'node:child_process';
import process from 'node:process';

const mount = `${process.cwd()}:/work`;
run([
  'run', '--rm', '-v', mount, '-w', '/work', 'rust:1.97.1-bookworm', 'bash', '-c',
  'cargo build --locked --release --manifest-path native/Cargo.toml && mkdir -p npm/linux-x64/bin && cp native/target/release/micro-sandbox npm/linux-x64/bin/micro-sandbox && chmod 755 npm/linux-x64/bin/micro-sandbox',
]);
run([
  'run', '--rm', '-v', mount, '-w', '/work', 'rust:1.97.1-bookworm', 'bash', '-c',
  'apt-get update -qq && apt-get install -y -qq gcc-aarch64-linux-gnu >/dev/null && rustup target add aarch64-unknown-linux-gnu && CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc cargo build --locked --release --target aarch64-unknown-linux-gnu --manifest-path native/Cargo.toml && mkdir -p npm/linux-arm64/bin && cp native/target/aarch64-unknown-linux-gnu/release/micro-sandbox npm/linux-arm64/bin/micro-sandbox && chmod 755 npm/linux-arm64/bin/micro-sandbox',
]);

function run(args) {
  const result = spawnSync('docker', args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
