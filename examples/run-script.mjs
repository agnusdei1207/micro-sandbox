export function scriptJob(source, options = {}) {
  return {
    ...(options.runtime ? { runtime: options.runtime } : {}),
    command: options.command ?? '/usr/bin/node',
    args: ['-e', source],
  };
}
