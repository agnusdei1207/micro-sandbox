# micro-sandbox

Fail-closed Linux process isolation for Node.js. Each command runs in disposable user, PID, mount, network, IPC, UTS, and cgroup namespaces with cgroup v2 limits, a private root, dropped capabilities, `no_new_privs`, seccomp, bounded I/O, and deterministic cleanup.

Runtime: Linux 5.15+ on x64 or ARM64. Development and unit tests also work on Windows. Node.js 24.18+ LTS is required.

```bash
npm install micro-sandbox
```

```js
import { createSandbox } from 'micro-sandbox';

await using sandbox = await createSandbox({
  cgroupRoot: '/sys/fs/cgroup/my-service/sandbox', // delegated cpu,memory,pids subtree
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

Defaults, hard ceilings, queue capacity, resource profiles, runtime roots, stdin, environment, working directory, cancellation, and the supervisor binary path are configurable. Core isolation controls cannot be disabled. Re-encoding and script recipes live in [`examples`](./examples); the package contains no file parser, sanitizer, storage adapter, or cloud coupling.

Architecture: [English](./docs/ARCHITECTURE.md) · [한국어](./docs/ARCHITECTURE.ko.md)

MIT
