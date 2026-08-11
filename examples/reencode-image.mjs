export function imageReencodeJob(input, options = {}) {
  const format = options.format ?? 'png';
  return {
    runtime: options.runtime ?? 'imagemagick',
    command: options.command ?? '/usr/bin/magick',
    args: ['-', `${format}:-`],
    stdin: input,
  };
}
