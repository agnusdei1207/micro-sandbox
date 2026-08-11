import { spawnSync } from 'node:child_process';
import process from 'node:process';

const mode = process.argv[2] ?? 'test';
const cwd = process.cwd();
const common = ['run', '--rm', '-e', 'CARGO_BUILD_JOBS=2', '-v', `${cwd}:/work`, '-w', '/work'];
const args = mode === 'kernel'
  ? [...common.slice(0, 2), '--privileged', '--cgroupns=private', ...common.slice(2), 'rust:1.97.1-bookworm', 'bash', 'scripts/run-native-privileged-tests.sh']
  : mode === 'integration'
    ? [...common.slice(0, 2), '--privileged', '--cgroupns=private', ...common.slice(2), 'node:24.18.0-bookworm', 'bash', 'scripts/run-node-integration.sh']
  : [...common, 'rust:1.97.1-bookworm', 'bash', '-c', 'rustup component add rustfmt clippy >/dev/null && cargo fmt --manifest-path native/Cargo.toml --check && cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path native/Cargo.toml'];
const result = spawnSync('docker', args, { stdio: 'inherit', shell: false });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
