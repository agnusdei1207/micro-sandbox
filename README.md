# micro-sandbox

Fail-closed Linux isolation for running untrusted commands from Node.js. It combines Linux namespaces, cgroup v2, a private root, zero capabilities, `no_new_privs`, seccomp, bounded resources, and deterministic cleanup.

Requires Node.js 24.18+ LTS and Linux 5.15+ at runtime (x64 or ARM64). npm, pnpm, and Yarn are supported. Development and unit tests also work on Windows.

```bash
pnpm add @agnusdei12071207/micro-sandbox
```

```ts
import { createSandbox } from '@agnusdei12071207/micro-sandbox';

await using sandbox = await createSandbox({
  cgroupRoot: '/sys/fs/cgroup/my-service/sandbox',
});

const result = await sandbox.run({
  command: '/bin/sh',
  args: ['-c', 'printf "isolated: %s" "$MESSAGE"'],
  env: { MESSAGE: 'hello' },
  limits: { timeoutMs: 2_000, memoryMb: 64, pids: 8 },
});

console.log(result.stdout.toString());
```

## Files and sanitizers

Large files use a separate bounded artifact channel, not the control protocol. Inputs accept a `Buffer`, host `sourcePath`, destroyable Node stream, or an `AbortSignal`-aware iterable factory. The guest sees read-only, non-executable `/input`; only explicitly declared regular files beneath `/output` are writable and non-executable. Outputs are returned only after the process tree is dead and native plus Node-side path, type, size, link, and SHA-256 checks pass.

```ts
// Multer memory-storage example. The command is your policy decision:
// ImageMagick, LibreOffice, Ghostscript, FFmpeg, or a custom re-encoder.
const result = await sandbox.run({
  command: '/usr/bin/convert',
  args: ['/input/upload', '-strip', '/output/safe.png'],
  artifacts: {
    inputs: [{ target: 'upload', data: file.buffer }],
    outputs: [{ path: 'safe.png', maxBytes: 5 * 1024 * 1024 }],
    limits: {
      inputFiles: 5,
      inputBytes: 8 * 1024 * 1024,
      inputFileBytes: 5 * 1024 * 1024,
      outputFiles: 1,
      outputBytes: 8 * 1024 * 1024,
      outputFileBytes: 5 * 1024 * 1024,
    },
  },
});

const safeFile = result.artifacts.find((file) => file.path === 'safe.png');
```

Validate the claimed media type before selecting a command, and validate the produced format before serving it. The sandbox contains parser compromise; it does not decide whether a transformation is semantically safe.

Declared outputs share `limits.outputFileBytes`; their count multiplied by that value must fit `limits.outputBytes`. This makes the total a kernel-enforced hard bound rather than a best-effort scan.
Set `required: false` for optional output slots; untouched empty optional files are omitted from the result.

## Configuration

Register caller-owned runtime roots and profiles for reusable commands and resource policies. Resource limits follow instance defaults → profile/job override → operator ceilings → immutable native ceilings. Artifact limits follow instance defaults → job override → operator ceilings → immutable native ceilings. Queueing, overload behavior, cancellation, working directory, environment, stdin, workspace location, and the supervisor binary are configurable; core isolation cannot be disabled.

`cgroupRoot` must be a dedicated writable cgroup-v2 subtree with `cpu`, `memory`, and `pids` delegated. With systemd, use `Delegate=cpu memory pids`. The package never elevates privileges or falls back to unisolated execution.

See [the architecture and operations guide](./docs/ARCHITECTURE.md) and the [examples](./examples).

MIT
