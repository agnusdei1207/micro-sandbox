# micro-sandbox architecture

## Purpose

`micro-sandbox` is a general-purpose Linux process sandbox distributed as an npm package. It runs untrusted commands, code, and file processors in disposable kernel-isolated jobs. It contains no format-specific parser, storage adapter, or cloud integration.

Supported hosts:

- Linux kernel 5.15 or newer
- x86-64 and ARM64
- cgroup v2 with a delegated subtree
- unprivileged user namespaces enabled, or an explicitly configured launcher

The package fails closed. It never reports an unisolated fallback as sandboxed.

## System shape

```text
Node.js API
    |
    | bounded, versioned IPC
    v
Rust supervisor (one child per Sandbox instance)
    |-- resource probe, reservation ledger, and queue
    |-- runtime and policy registry
    |-- cgroup lifecycle and job monitoring
    `-- one disposable child per job
          |-- USER, PID, MOUNT, NET, IPC, UTS, CGROUP namespaces
          |-- private tmpfs root and pivot_root
          |-- no_new_privs, dropped capabilities, seccomp
          `-- command, code runtime, or sanitizer
```

The supervisor is trusted but does not parse untrusted file formats. Parsers and user commands only run inside job processes.

## Public model

`createSandbox()` starts the supervisor lazily. `sandbox.run()` executes a job. `sandbox.close()` stops admission, drains or cancels work, and removes all resources.

```ts
await using sandbox = await createSandbox();

const result = await sandbox.run({
  command: "/app/tool",
  args: ["--input", "/workspace/input"],
  files: { "/workspace/input": input },
  outputs: ["/workspace/output"],
});
```

The same primitive supports native tools, registered Node or Python runtimes, compilation, media conversion, and user-supplied sanitizers.

## Configuration

Policy is layered in this order:

1. safe package defaults;
2. instance defaults and operator ceilings;
3. a named runtime or task profile;
4. per-job values within the operator ceilings.

Default limits:

| Resource | Default | Default ceiling |
|---|---:|---:|
| Wall time | 5 s | 30 s |
| Memory | 256 MiB | 512 MiB |
| Swap | 0 | 0 |
| CPU quota | 0.5 core | 1 core |
| Processes | 16 | 32 |
| Input | 25 MiB | 100 MiB |
| Combined output | 50 MiB | 200 MiB |

Operators may change defaults and ceilings. Jobs may only request values within them. Core isolation invariants cannot be disabled.

## Job lifecycle

1. Validate the request, paths, runtime digest, policy, and size bounds.
2. Read effective cgroup CPU, memory, and PID capacity.
3. Atomically reserve capacity or apply queue backpressure.
4. Create and configure the job cgroup.
5. Create the child with `clone3()` and place it in the cgroup from birth.
6. Write UID/GID mappings while the child is blocked on a synchronization pipe.
7. Make mount propagation private; build a tmpfs root; bind only verified runtime assets; call `pivot_root()`.
8. Keep the network namespace disconnected, close inherited descriptors, set `no_new_privs`, drop capabilities, and install the profile's seccomp filter.
9. Execute the workload while the supervisor bounds time, output, memory, CPU, and descendants.
10. Validate and collect declared outputs.
11. Kill remaining descendants with pidfds and `cgroup.kill`, reap them, unmount the root, remove the cgroup, and release the reservation.

Every failure follows the same cleanup path.

## Security invariants

- No shell interpolation.
- No host network by default.
- No host filesystem, environment, or file descriptor inheritance by default.
- Only normalized absolute guest paths; no `..`, symlink, device, or mount escape.
- Runtime bundles and custom processors are registered at startup and digest-verified.
- Extension policies can tighten isolation but cannot enable forbidden capabilities or host access.
- A successful result includes an isolation report. Missing mandatory controls produce `ISOLATION_UNAVAILABLE`.
- Namespace isolation shares the host kernel; this is not a VM boundary.

## Capacity and stability

The Rust supervisor owns a single reservation ledger to avoid concurrent over-admission. Available capacity is the minimum of host availability and the supervisor's effective cgroup headroom, minus an operator reserve and active reservations.

Automatic concurrency considers CPU quota, memory, PIDs, current jobs, and Linux pressure stall information. On pressure it pauses admission. The configured overload mode either waits in a bounded FIFO queue or returns `CAPACITY_EXCEEDED`.

The Node client monitors a heartbeat. If the supervisor exits, active jobs fail deterministically, stale resources are reconciled, and a later request may restart it. Output floods, ignored signals, double forks, OOMs, and timeouts are terminated at the cgroup boundary.

## Extensibility

Extensions are isolated executables, never dynamic libraries loaded into the supervisor.

A registered runtime specifies an immutable rootfs or bundle, entrypoint, digest, base profile, and allowed environment keys. A task profile derives from a built-in profile and may adjust limits or add reviewed syscalls within a hard deny set. User-controlled requests cannot register runtimes, executable paths, mounts, or seccomp policies.

Built-in profiles cover strict native execution, interpreted code, compilation, and media processing. Recipes demonstrate how to register a sanitizer or transcoder without making its parser, format policy, or storage destination part of the core package.

## Errors and observability

The API uses stable codes such as `CAPACITY_EXCEEDED`, `POLICY_VIOLATION`, `ISOLATION_UNAVAILABLE`, `TIMEOUT`, `OUT_OF_MEMORY`, `OUTPUT_TOO_LARGE`, `SECCOMP_VIOLATION`, and `PROCESSOR_CRASH`.

Results expose exit status, bounded stdout/stderr, declared output files, applied isolation controls, resource usage, and duration. Hooks receive lifecycle events without file contents, secrets, or inherited environment values.

## Distribution and discovery

The JavaScript package selects a platform binary from optional packages for Linux x86-64 or ARM64. Unsupported platforms fail during initialization with a direct diagnostic.

The npm manifest and README use a concise, consistent description and focused search terms: `sandbox`, `linux-sandbox`, `nodejs-sandbox`, `process-isolation`, `untrusted-code`, `cgroups`, `namespaces`, `seccomp`, `resource-limits`, and `rootless`. Repository, homepage, issues, engines, OS, CPU, license, and provenance metadata remain complete and accurate. GitHub topics mirror the main npm keywords.

## Verification gates

Release gates include:

- Rust and TypeScript unit tests;
- protocol and policy compatibility tests;
- Linux x86-64 and ARM64 integration tests;
- namespace, cgroup, mount, network, and seccomp assertions;
- fork, memory, CPU, output, file-count, and decompression bombs;
- symlink, path traversal, descriptor, environment, `/proc`, and network escape attempts;
- timeout, OOM, supervisor crash, cancellation, and cleanup fault injection;
- concurrent admission and resource-reservation stress tests;
- repeated-run leak and soak tests;
- packed-tarball installation and smoke tests.

A release is blocked if mandatory isolation is skipped, a child or cgroup survives cleanup, either architecture fails, or the packed npm artifact cannot run independently.
