# micro-sandbox

Fail-closed Linux process isolation for Node.js. Untrusted commands run with user, PID, mount, network, IPC, UTS, and cgroup namespaces; cgroup v2 limits; a private root; zero capabilities; `no_new_privs`; seccomp; bounded I/O; and deterministic cleanup.

Requires Node.js 24.18+ LTS and Linux 5.15+ at runtime (x64 or ARM64). Development and unit tests work on Windows.

```bash
npm install @agnusdei12071207/micro-sandbox
```

```js
import { createSandbox } from '@agnusdei12071207/micro-sandbox';

await using sandbox = await createSandbox({
  cgroupRoot: '/sys/fs/cgroup/my-service/sandbox',
});

sandbox.registerRuntime({
  id: 'host-tools',
  rootfs: '/',
  entrypoint: '/bin/sh',
});

const result = await sandbox.run({
  runtime: 'host-tools',
  args: ['-c', 'printf "isolated: %s" "$MESSAGE"'],
  env: { MESSAGE: 'hello' },
  limits: { timeoutMs: 2_000, memoryMb: 64, pids: 8 },
});

console.log(result.stdout.toString()); // isolated: hello
```

## Runtime setup

`cgroupRoot` must be a dedicated, empty, writable cgroup-v2 subtree with the `cpu`, `memory`, and `pids` controllers delegated to the service. With systemd, configure the service with `Delegate=cpu memory pids`. `MICRO_SANDBOX_CGROUP_ROOT` can supply the same path globally.

The package never elevates privileges or falls back to unisolated execution. Invalid delegation, unsupported kernels, or unsupported platforms fail during sandbox startup.

Defaults, ceilings, queues, profiles, runtimes, stdin, environment, working directory, cancellation, and the native binary path are configurable. Core isolation cannot be disabled. Re-encoding and script execution are composition examples in [`examples`](./examples), not coupled parsers or cloud adapters.

Architecture: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

MIT
