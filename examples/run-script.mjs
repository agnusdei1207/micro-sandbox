export function scriptJob(source, options = {}) {
  return {
    runtime: options.runtime ?? 'node',
    command: options.command ?? '/usr/bin/node',
    args: ['-e', source],
  };
}
