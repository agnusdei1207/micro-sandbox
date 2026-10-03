import process from 'node:process';
import { run } from './lib/exec.mjs';
import { IMAGES } from './lib/platforms.mjs';

const MODES = {
  test: {
    privileged: false,
    image: IMAGES.rustBookworm,
    command: ['bash', '-c', 'rustup component add rustfmt clippy >/dev/null && cargo fmt --manifest-path native/Cargo.toml --check && cargo clippy --locked --manifest-path native/Cargo.toml --all-targets -- -D warnings && cargo test --locked --manifest-path native/Cargo.toml'],
  },
  kernel: {
    privileged: true,
    image: IMAGES.rustBookworm,
    command: ['bash', 'scripts/run-native-privileged-tests.sh'],
  },
  integration: {
    privileged: true,
    image: IMAGES.nodeBookworm,
    command: ['bash', 'scripts/run-node-integration.sh'],
  },
};

const mode = process.argv[2] ?? 'test';
const definition = Object.hasOwn(MODES, mode) ? MODES[mode] : undefined;
if (!definition) throw new Error(`Unsupported native test mode ${mode}`);
run('docker', [
  'run', '--rm',
  ...(definition.privileged ? ['--privileged', '--cgroupns=private'] : []),
  '-e', 'CARGO_BUILD_JOBS=2',
  '-v', `${process.cwd()}:/work`, '-w', '/work',
  definition.image, ...definition.command,
], { label: `native ${mode} tests` });
