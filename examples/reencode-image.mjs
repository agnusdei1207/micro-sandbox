export function imageReencodeJob(input, options = {}) {
  const format = options.format ?? 'png';
  if (!['jpeg', 'png', 'webp'].includes(format)) throw new TypeError('Unsupported output format');
  return {
    runtime: options.runtime ?? 'imagemagick',
    command: options.command ?? '/usr/bin/magick',
    args: ['/input/upload', '-strip', `/output/safe.${format}`],
    artifacts: {
      inputs: [{ target: 'upload', data: input }],
      outputs: [{ path: `safe.${format}` }],
      limits: {
        inputFiles: 1,
        inputBytes: options.inputBytes ?? 8 * 1024 * 1024,
        outputFiles: 1,
        outputBytes: options.outputBytes ?? 8 * 1024 * 1024,
        outputFileBytes: options.outputBytes ?? 8 * 1024 * 1024,
      },
    },
  };
}
