import process from 'node:process';
import { run } from './lib/exec.mjs';
import { IMAGES, parseCurrentArch, selectedPlatforms } from './lib/platforms.mjs';

const mount = `${process.cwd()}:/work`;
const current = parseCurrentArch(process.argv, { label: 'build' });
for (const platform of selectedPlatforms(current)) {
  const output = `${platform.directory}/bin`;
  run('docker', [
    'run', '--rm', '--platform', platform.dockerPlatform, '-v', mount, '-w', '/work',
    IMAGES.rustAlpine, 'sh', '-c',
    `CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=/tmp/target cargo build --locked --release --manifest-path native/Cargo.toml && mkdir -p ${output} && cp /tmp/target/release/micro-sandbox ${output}/micro-sandbox && chmod 755 ${output}/micro-sandbox`,
  ], { label: `docker native build for ${platform.arch}` });
}
