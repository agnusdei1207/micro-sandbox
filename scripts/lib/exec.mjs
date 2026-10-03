import { spawnSync } from 'node:child_process';
import process from 'node:process';

// Runs a command without a shell. A spawn error or non-zero status throws with
// the captured output unless `allowFailure` is set.
export function run(command, args, {
  cwd,
  env,
  input,
  capture = false,
  allowFailure = false,
  label = `${command} ${args[0] ?? ''}`.trim(),
} = {}) {
  const output = capture ? 'pipe' : 'inherit';
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: [input === undefined ? 'inherit' : 'pipe', output, output],
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
    const status = result.status ?? result.signal;
    throw new Error(`${label} failed with status ${status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

// Prefers the npm CLI that launched this script so `npm run` works on Windows
// without resolving npm.cmd through a shell.
export function runNpm(args, options = {}) {
  const npmCli = process.env.npm_execpath;
  const label = options.label ?? `npm ${args[0] ?? ''}`.trim();
  return npmCli
    ? run(process.execPath, [npmCli, ...args], { ...options, label })
    : run('npm', args, { ...options, label });
}

export function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
