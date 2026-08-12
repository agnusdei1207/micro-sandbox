# micro-sandbox architecture

## Scope and guarantees

`micro-sandbox` is a generic command sandbox. Callers choose the executable, runtime root, and transformation policy; the core has no file parser, sanitizer, cloud adapter, or storage dependency.

- Runtime: Linux 5.15+, cgroup v2, x86-64 or ARM64.
- Toolchain: Node.js 24.18+ LTS, Rust 1.97.1, Edition 2024.
- Boundary: hardened process/container isolation sharing the host kernel, not a VM.
- Failure mode: every mandatory control fails closed; no unisolated fallback exists.

The untrusted boundary is the isolated command and its descendants. The Node service, Rust supervisor, runtime root, cgroup delegation, and other host processes running as the same Unix UID are trusted. Use a dedicated service account and a private `0700` workspace root; do not share that UID with untrusted host processes.

## Components and data flow

```text
Node API (policy, bounded queue, runtime/profile registries)
  ├─ bounded versioned control protocol ──> Rust supervisor
  │                                        ├─ live cgroup admission
  │                                        └─ guarded launcher per job
  │                                             └─ isolated process tree
  └─ private artifact workspace ─────────> /input (ro,noexec)
                                           /output (rw,noexec)
```

The supervisor never loads plugins or parses caller content. A fresh single-threaded launcher creates namespaces, avoiding unsafe post-fork work in the multi-threaded supervisor.

## Policy and extensibility

`Sandbox.run()` accepts a command or registered runtime, arguments, guest working directory, explicit environment, bounded stdin, resource overrides, `AbortSignal`, and optional artifacts. A runtime is only an immutable `{ rootfs, entrypoint }` mapping; profiles are reusable limit layers. This keeps ImageMagick, Sharp, LibreOffice, FFmpeg, compilers, and private tools outside the trusted core while giving all of them the same containment.

Resource policy order is package defaults → instance defaults/ceilings → profile → job override. Artifact policy uses package defaults → instance defaults/ceilings → job override. Native immutable limits remain authoritative if Node-side policy is misconfigured or bypassed.

Raw stdin and combined stdout/stderr have a 512 KiB native maximum. Large payloads use artifacts: default input/output totals are 16/32 MiB; configurable ceilings default to 256 MiB; the native ceiling is 1 GiB and 1,024 files. The artifact filesystem retains 20% free-space headroom and concurrent jobs reserve their declared input plus output budgets.

## Artifact lifecycle

1. Node resolves policy, reserves disk capacity, and creates a random per-job directory beneath a dedicated workspace root.
2. `Buffer`, `sourcePath`, and `AsyncIterable` inputs are copied with exclusive, no-follow file handles. Normalized relative POSIX paths, counts, bytes, duplicates, and cancellation are checked while staging.
3. Rust canonicalizes the configured root and workspace, requires direct containment, rejects links and non-regular files, verifies limits, and requires an empty output directory.
4. The launcher bind-mounts `/input` and the `/output` directory tree read-only. It then overlays only explicitly declared, pre-created regular output files as writable. All mounts are `nosuid,nodev,noexec`; the child receives no host workspace path and cannot create undeclared files or replace directories.
5. Declared files use one uniform maximum, and their count multiplied by that maximum must fit the total output budget. `RLIMIT_FSIZE` therefore creates a kernel-enforced aggregate upper bound. Seccomp denies `fallocate` and io_uring allocation bypasses; Rust additionally scans the output tree for bytes, allocated blocks, entries, depth, links, and unsupported types.
6. After the process tree is killed/reaped and the cgroup is removed, Rust reopens regular single-link files with `O_NOFOLLOW`, hashes them, and returns only a manifest.
7. Node independently reopens every manifest path with `O_NOFOLLOW`, rechecks type/link/size/aggregate limits and SHA-256, reads the result, and removes the job workspace before settling the promise.

Artifact output is buffered only after successful validation. Keep limits appropriate for the service memory budget; send returned buffers to caller-owned storage promptly. MIME detection and semantic output validation remain caller responsibilities.

## Isolation lifecycle

1. Validate protocol fields, numeric limits, paths, environment, runtime root, and workspace.
2. Generate an opaque supervisor-owned cgroup ID and atomically reserve live capacity across delegated ancestors.
3. Apply memory, zero-swap, CPU, and PID limits, then use `clone3` with `CLONE_INTO_CGROUP` and USER/PID/MNT/NET/IPC/UTS/CGROUP namespaces.
4. Complete the race-free parent/child mapping handshake within the job deadline.
5. Make mount propagation private; create a tmpfs root; recursively bind only runtime `bin`, `sbin`, `usr`, `lib`, and `lib64`; add private `/proc`, `/tmp`, and safe devices; then `pivot_root` and detach the host root.
6. Clear capabilities, disable dumps, set `no_new_privs`, install seccomp, and `execve` with an explicit environment.
7. Enforce timeout/cancellation with pidfds and `cgroup.kill`; drain bounded streams concurrently; read OOM events and peak memory; reap and clean all state.

RAII guards converge setup, I/O, cancellation, protocol, and supervisor-failure paths on kill/reap/cleanup. Startup reconciles only stale cgroups belonging to dead supervisor owners, so live sandbox instances can share a delegated root.

## Syscall and filesystem boundary

Runtime mount sources must canonically remain beneath the configured root. Recursive `mount_setattr` makes nested mounts read-only, `nosuid`, and `nodev`. Host `/etc`, homes, secrets, sockets, and inherited environment are absent. `/tmp` is private and size-limited; `/dev` contains only `null`, `zero`, `random`, and `urandom`.

All capability masks are zero. Seccomp denies legacy/new mount APIs, namespace reassignment and namespace-creating clone flags, ptrace, BPF, modules, keyrings, reboot, swap, kexec, perf, userfaultfd, and related high-risk calls. Networking uses a private namespace with no host interfaces or routes.

This defense-in-depth boundary does not claim VM-equivalent isolation or immunity from future Linux kernel vulnerabilities. Use a VM boundary as well when processing data from adversaries that justify that threat model.

## Deployment and release

Create a dedicated empty cgroup-v2 subtree with `cpu`, `memory`, and `pids` delegated. With systemd, configure `Delegate=cpu memory pids`; pass the child path as `cgroupRoot` or `MICRO_SANDBOX_CGROUP_ROOT`. Put `workspaceRoot` on a private local filesystem with sufficient space; when supplied by the caller, the directory is never removed by the package.

The main package can be installed by npm, pnpm, or Yarn. Optional x64/ARM64 packages contain static musl ELF binaries. Windows is supported for installation, development, and unit testing; actual jobs fail closed outside Linux.

Release gates include TypeScript tests, Rustfmt, Clippy with denied warnings, Rust tests on both architectures, privileged namespace/cgroup/seccomp tests, public API integration with multi-megabyte artifacts, npm audit, static ELF validation, clean packed installation, version/tag equality, and SHA-256 checksums.
