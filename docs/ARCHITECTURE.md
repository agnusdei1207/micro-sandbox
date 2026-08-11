# micro-sandbox architecture

## Scope

`micro-sandbox` is a generic command sandbox, not a file sanitizer. Callers choose the executable and runtime root; re-encoding, parsing, storage, and cloud integration remain outside the trusted core.

- Runtime: Linux 5.15+, cgroup v2, x86-64 or ARM64.
- Toolchain: Node.js 24.18+ LTS, Rust 1.97.1, Edition 2024.
- Boundary: hardened process/container isolation sharing the host kernel, not a VM.
- Behavior: mandatory controls fail closed; no unisolated fallback exists.

## Components

```text
Node.js API
  ├─ immutable defaults/ceilings, bounded queue, profiles, runtimes
  └─ bounded protocol v1
       └─ Rust supervisor
            ├─ live cgroup capacity + atomic reservations
            └─ one single-threaded launcher per job
                 └─ clone3 child in USER/PID/MNT/NET/IPC/UTS/CGROUP namespaces
```

The supervisor never loads caller plugins or parses caller files. A fresh, single-threaded launcher performs namespace creation, avoiding unsafe post-fork interaction with supervisor threads.

## API and policy

`Sandbox.run()` accepts a command or registered runtime, arguments, guest working directory, explicit environment, bounded stdin, resource overrides, and `AbortSignal`. Results include exit/signal state, timeout, OOM and output-limit flags, bounded stdout/stderr, duration, sampled peak memory, and the isolation report.

Policy order is package defaults → instance defaults/ceilings → profile → job override. Defaults are 5 s, 256 MiB, 0.5 CPU, 16 PIDs, 64 KiB input, and 256 KiB combined output. Default ceilings are 30 s, 512 MiB, 1 CPU, 32 PIDs, and 512 KiB input/output. The native layer permanently caps raw input and combined output at 512 KiB even if a caller raises Node-side ceilings.

The Node queue is bounded (hard maximum 64 active jobs). The native request channel and active set are also bounded. Each native reservation includes launcher/supervisor overhead. Before every launch, the supervisor reads capacity across the delegated cgroup and its cgroup-v2 ancestors, keeps a 20% reserve, and atomically checks the new request plus all outstanding reservations. Swap is always disabled.

## Job lifecycle

1. Validate the bounded protocol, numeric limits, paths, environment, input, and runtime root.
2. Generate an opaque cgroup ID inside the supervisor; caller identifiers never become filesystem paths.
3. Reserve current capacity, create the cgroup, and apply memory, zero-swap, CPU, and PID limits.
4. Start a guarded launcher, open pidfds, and use `clone3` with `CLONE_INTO_CGROUP` plus all required namespaces.
5. Write one-entry UID/GID maps while the child is blocked. Setup time counts toward the job deadline.
6. Make mount propagation private; create a tmpfs root; recursively bind runtime directories read-only, `nosuid`, and `nodev`; add safe devices and private `/proc` and `/tmp`; then `pivot_root` and detach the host root.
7. Change directory, clear every capability set, disable core dumps, set `no_new_privs`, install seccomp, and `execve` with an explicit environment.
8. Drain all standard streams concurrently within immutable aggregate bounds. Enforce timeout and cancellation with pidfds and `cgroup.kill`.
9. Reap namespace init, kill descendants, read OOM events and peak memory (falling back to bounded `memory.current` sampling on Linux 5.15), remove cgroup/staging state, and release the reservation.

RAII guards converge setup, I/O, protocol, cancellation, and supervisor-failure paths on kill/reap/cleanup. Parent-death signals cover both supervisor→launcher and launcher→isolated-child relationships, including the setup race. Startup reconciles stale owned cgroups.

## Filesystem and syscall boundary

Only runtime `/bin`, `/sbin`, `/usr`, `/lib`, and `/lib64` directories are mounted. Their canonical targets must remain beneath the canonical runtime root. Recursive `mount_setattr` makes nested submounts read-only, `nosuid`, and `nodev`. Host `/etc`, homes, secrets, sockets, and inherited environment are absent. `/tmp` is private, size-limited, `nodev`, `nosuid`, and `noexec`; `/dev` contains only `null`, `zero`, `random`, and `urandom`.

All capability masks are zero. Seccomp denies legacy and new mount APIs, namespace reassignment, namespace-creating clone operations, ptrace, BPF, modules, keyrings, reboot, swap, kexec, perf, userfaultfd, and related high-risk calls. Network has a private namespace without host interfaces or routes.

The seccomp denylist is defense in depth around namespaces, capabilities, mounts, and cgroups. This project does not claim immunity from every future kernel vulnerability or VM-equivalent isolation.

## Extensibility

Extension is composition: register any caller-owned root and entrypoint, then run it under the same non-disableable controls. Image re-encoding can call ImageMagick; code execution can call Node, Python, a compiler, or a custom program. The package itself has no parser, sanitizer, S3 adapter, or runtime dependency.

The public API intentionally exposes only bounded stdin/stdout/stderr. Arbitrary artifact recovery requires a separately designed, verified data plane.

## Deployment and release

Provide a dedicated, empty, writable cgroup-v2 subtree with `cpu`, `memory`, and `pids` delegated. With systemd, use `Delegate=cpu memory pids` and pass the child subtree as `cgroupRoot` or `MICRO_SANDBOX_CGROUP_ROOT`.

The main npm package supports Windows development but rejects execution outside supported Linux systems. Optional x64/ARM64 packages contain static musl ELF binaries, avoiding a glibc userspace dependency.

Release gates cover strict TypeScript tests on Windows/Linux, Rustfmt, Clippy with denied warnings, Rust tests on x64/ARM64, privileged namespace/cgroup/seccomp and public-API integration on both architectures, cancellation/crash cleanup, output and capacity races, npm audit, static ELF validation, packed clean installation, version/tag equality, and SHA-256 checksums.
