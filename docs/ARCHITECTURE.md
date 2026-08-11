# micro-sandbox architecture

## 1. Scope and support

`micro-sandbox` is a general-purpose process sandbox distributed through npm. It executes caller-selected programs; format parsing, sanitizing, storage, and cloud integration remain outside the trusted core.

- Runtime: Linux kernel 5.15+, cgroup v2, x86-64 or ARM64.
- Tooling: Node.js 24.18+ LTS, Rust 1.97.1, Edition 2024.
- Development: TypeScript tests and packaging work on Windows and Linux; kernel integration requires Linux.
- Boundary: namespaces share the host kernel. This is a hardened process/container boundary, not a VM boundary.

Mandatory controls fail closed. There is no unisolated fallback.

## 2. Components

```text
Node.js API
  ├─ policy ceilings, FIFO queue, runtimes, resource profiles
  └─ bounded protocol v1
       └─ Rust supervisor
            ├─ live cgroup capacity probe + reservation ledger
            └─ launcher process per job
                 └─ clone3 child in USER/PID/MNT/NET/IPC/UTS/CGROUP namespaces
```

The long-lived supervisor never loads caller plugins or parses caller files. Each launcher is a fresh single-threaded process before `clone3`, avoiding unsafe post-fork interaction with supervisor threads.

## 3. Public execution model

`Sandbox.run()` accepts a command or a registered runtime entrypoint, arguments, a normalized guest working directory, explicit environment values, bounded stdin, resource overrides, and an `AbortSignal`. It returns exit status, numeric signal, timeout/output-limit flags, bounded stdout/stderr, peak memory, duration, and the applied isolation report.

Runtimes are caller-owned root directories plus entrypoints. Profiles are caller-defined resource-limit templates. Neither mechanism adds parsers or weakens isolation.

## 4. Policy and capacity

Policy order is package defaults → instance defaults/ceilings → profile → job override. Defaults are 5 seconds, 256 MiB, 0.5 CPU, 16 PIDs, 64 KiB input, and 256 KiB combined output. Default ceilings are 30 seconds, 512 MiB, 1 CPU, 32 PIDs, and 512 KiB for input and combined output. Swap is always zero.

Before every launch, the supervisor reads the delegated cgroup's current/max memory and PID values plus CPU quota. Unbounded values use host availability. Only 80% is admitted, leaving an operating reserve. An atomic ledger also reserves each active job's declared maximum; insufficient live or reserved capacity returns `CAPACITY_EXCEEDED` before process creation.

The Node layer provides a bounded FIFO queue and configurable in-flight count. Kernel cgroups remain the final enforcement boundary.

## 5. Job lifecycle

1. Validate protocol size, paths, NULs, environment, base64 input, and numeric limits.
2. Recheck live capacity and atomically reserve the declared maximum.
3. Create the job cgroup and write memory, zero-swap, CPU, and PID limits.
4. Start a dedicated launcher, open a pidfd, and call `clone3` with all namespaces and `CLONE_INTO_CGROUP`.
5. Block the child while the parent writes one-entry UID/GID maps.
6. Make mount propagation private, mount a tmpfs root, read-only bind runtime directories, add only safe devices, mount private `/proc` and `/tmp`, then call `pivot_root` and detach the host root.
7. Set the working directory, clear every capability set, set `no_new_privs`, install seccomp, close helper descriptors on exec, and execute without a shell unless the caller explicitly selected one.
8. Drain stdin/stdout/stderr concurrently under aggregate bounds. Enforce wall time and process-tree cancellation with pidfds plus `cgroup.kill`.
9. Reap the namespace init, kill remaining descendants, read peak memory, remove the cgroup/staging directory, and release the reservation.

The isolated child receives a parent-death signal, and the supervisor reconciles the cgroup if a launcher is killed.

## 6. Filesystem and runtime model

The runtime root is never exposed wholesale. Only `/bin`, `/sbin`, `/usr`, `/lib`, and `/lib64` are recursively bound read-only into a fresh tmpfs root. Host `/etc`, home directories, application secrets, sockets, and inherited environment are absent. `/tmp` is private, size-limited, `nodev`, `nosuid`, and `noexec`. `/dev` contains only bind-mounted `null`, `zero`, `random`, and `urandom`.

Version 0.0.1 intentionally exposes bounded stdin/stdout/stderr rather than pretending arbitrary output files can be safely recovered. Larger artifact transport can be added later as a separate, verified data plane without changing the sandbox boundary.

## 7. Security invariants

- Network namespace has no host interfaces or routes.
- Effective, permitted, inheritable, bounding, and ambient capability masks must all be zero.
- `no_new_privs` and the baseline seccomp filter are mandatory.
- Mount, namespace reassignment, ptrace, BPF, kernel-module, keyring, reboot, swap, kexec, perf, userfaultfd, and related high-risk syscalls are denied.
- Paths are normalized absolute guest paths; arguments and environment reject NULs and bounded environment sizes.
- Control frames are limited to 1 MiB; stdout and stderr share one aggregate output budget.
- Job IDs are constrained before becoming cgroup paths.
- Missing clone3, namespaces, delegated controllers, cgroup v2, pivot root, capability clearing, or seccomp aborts the job.

The denylist seccomp layer is defense in depth around namespace/capability/filesystem isolation; it is not advertised as a VM or a proof against every future kernel vulnerability.

## 8. Extensibility and examples

Extension is composition: register a caller-owned runtime and execute its binary. Image re-encoding can invoke ImageMagick; code execution can invoke Node, Python, a compiler, or a custom executable. The examples only build generic job requests. They do not make those tools dependencies of the package.

Operators can customize safe defaults, hard ceilings, queue capacity, resource profiles, runtime rootfs paths, entrypoints, and the native binary path. Namespace, network, cgroup, capability, pivot-root, and seccomp controls are not configurable off.

## 9. Deployment and packaging

The service must receive a writable cgroup v2 subtree delegated with `cpu`, `memory`, and `pids` controllers enabled. With systemd, use `Delegate=cpu memory pids` and pass the resulting empty child subtree as `cgroupRoot` or `MICRO_SANDBOX_CGROUP_ROOT`. The supervisor validates it and never silently chooses a weaker mode.

The main npm package installs on Windows for development but rejects execution there. Optional `micro-sandbox-linux-x64` and `micro-sandbox-linux-arm64` packages carry the corresponding ELF binary. CI builds and tests natively on both architectures; releases publish platform packages before the main package with npm provenance.

## 10. Verification and release gates

Required gates are strict TypeScript compilation, Node unit/API tests on Windows and Linux, Rustfmt, Clippy with warnings denied, Rust unit/integration tests, real privileged cgroup/namespace/seccomp tests, cancellation and timeout process-tree cleanup, aggregate output limits, capacity race tests, npm audit, ELF architecture/mode checks, packed-tarball clean installs, and published-package smoke tests.

A release is blocked if isolation is skipped, an output/control bound is bypassed, a child/cgroup/staging root survives, x64 or ARM64 packaging is wrong, metadata is misleading, or a clean consumer cannot run the published package.
