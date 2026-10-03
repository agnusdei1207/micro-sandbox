# Architecture

`micro-sandbox` separates caller policy, process supervision, and guest execution. It is a process/container boundary sharing the host kernel. The Node application, supervisor, runtime root, cgroup delegation, and host processes sharing the service UID are trusted; the guest command and its descendants are untrusted.

Purpose and constraints belong to the [project intent](intents/00-project.md). Deployment and commands belong to [operations](OPERATIONS.md); [terms](GLOSSARY.md) and [audit evidence](intents/0001-audit-and-refactor.md) have separate owners.

## Module ownership

| Module | Responsibility | Interface |
|---|---|---|
| Node API (`src/api`) | Bounded FIFO admission, registry ownership, request preparation, result validation, and cleanup before settlement | `createSandbox`, `Sandbox.run/close`, runtime/profile registries |
| Node policy (`src/policy`) | Resource and artifact defaults, override validation, ceilings, and guest path rules; no filesystem I/O | Resource/artifact policy resolution |
| Artifact workspace (`src/artifacts`) | Disk reservation, input staging, declaration enforcement, independent manifest verification, and workspace removal | Prepared workspace and collected artifact buffers |
| Platform and transport (`src/platform`, `src/supervisor`) | Resolve trusted binary/environment, bounded JSON frames, response correlation, cancellation, and transport shutdown | `SupervisorRequester` boundary |
| Rust supervisor (`native/src/supervisor.rs`) | Live admission, launcher lifecycle, request correlation, cancellation, and stale-cgroup reconciliation | Version 1 `health/run/cancel/shutdown` protocol |
| Rust resources and scheduler | Read host/ancestor resource headroom and reserve capacity within one supervisor | Capacity snapshots and RAII reservations |
| Rust job and Linux modules | Validate launch specification, establish isolation, enforce execution limits, collect bounded streams, kill/reap, and clean cgroups | Single-threaded launcher per job |
| Rust artifacts | Validate workspace containment, pin declared output files, inspect output tree, and hash output contents | Workspace specification to manifest |

The current maintenance intent is [0001](intents/0001-audit-and-refactor.md). Policy stays independent of filesystem I/O; the workspace does not select tools or parse caller content. The supervisor launches a fresh process before namespace creation to avoid post-fork work in its multithreaded address space.

## Job and artifact flow

```text
Node API -> policy + admission -> bounded control protocol -> Rust supervisor
    |                                                        |
    +-> private workspace                              job launcher
          input/  -> guest /input (read-only)                 |
          output/ -> declared writable guest files      isolated command
    |                                                        |
    +<- Node manifest verification <- manifest <- kill/reap + native checks
    +-> workspace cleanup -> settle run() promise
```

1. Node resolves runtime/profile/resource policy and checks stdin before staging artifacts or starting the supervisor. It reserves input plus output disk budgets while a workspace is active.
2. Node creates a random job directory, stages inputs, and pre-creates declared empty output files. Rust independently checks containment, regular files, link counts, declarations, and limits.
3. The supervisor generates its own cgroup identifier and reserves memory/CPU/PID capacity. The launcher applies cgroup limits and uses `clone3` with `CLONE_INTO_CGROUP` and USER/PID/MNT/NET/IPC/UTS/CGROUP namespaces.
4. The child establishes user mappings, mount isolation, a private root, explicit environment, zero capabilities, `no_new_privs`, and seccomp before executing the command.
5. Input and output directory trees are mounted read-only and non-executable; only declared regular output files are overlaid writable. A uniform file-size limit and blocked allocation bypasses bound declared output storage. Private root and `/tmp` tmpfs storage are separate from artifact output budgets.
6. After the guest is killed/reaped and its cgroup cleaned, Rust reads the pinned output file handles, checks sizes and filesystem allocation, and returns a manifest. Node independently opens and validates the reported files and checks required entries and hashes before returning buffers.

## Limits and failure ownership

Resource policy is package defaults, instance defaults, profile limits, then job overrides, checked against instance ceilings. Native code independently checks positivity/finite values and live admission; immutable numeric maxima apply to raw stdin/stdout and artifacts, not every resource field. Raw stdin and combined stdout/stderr have a native 512 KiB maximum. Artifact native bounds are 1 GiB and 1,024 files. Defaults are exported by the Node policy modules.

Node queue capacity, native scheduler capacity, and disk reservations are different controls. Scheduler reservations are local to a supervisor; multiple supervisors observe shared live cgroup usage but do not share a global reservation lock. Operators must provision and budget shared deployments accordingly.

RAII guards cover ordinary setup, execution, cancellation, and error paths. Parent-death signals terminate launchers and guests if their owner dies; guest seccomp prevents clearing that setting. Launchers report failures as a structured error that the supervisor relays with its original code. Each launcher stages its private root in a randomly named directory inside a per-user `0700` temporary directory. After a launcher exits or is cancelled, the supervisor removes its cgroup and staging directory off the protocol loop before answering; a cleanup failure is logged without affecting other jobs. Forced supervisor death can leave empty cgroup and staging directories, which the next supervisor reconciles only when the recorded owner is dead. Live owners are preserved.

Live admission counts each running job's reservation only once: cgroup headroom already excludes the jobs' measured memory and PID usage, so only the unused remainder of existing reservations is subtracted again, while the startup budget bounds total reservations.

## Filesystem and syscall boundary

Runtime sources must canonically remain inside the configured root. Only `bin`, `sbin`, `usr`, `lib`, and `lib64` are recursively mounted read-only, `nosuid`, and `nodev`. Host `/etc`, homes, and environment are not mounted/inherited into the guest. Safe devices are `null`, `zero`, `random`, and `urandom`.

The private root is a writable 16 MiB tmpfs and permits execution; `/tmp` is another 16 MiB tmpfs with `noexec`. Artifact mounts use `noexec`, which prevents direct execution from those mounts but does not stop an interpreter from reading a script. Runtime compatibility and tool selection remain caller policy.

Seccomp blocks mount/namespace manipulation (including `fspick` and `open_tree_attr`), ptrace and cross-process memory or descriptor access (`process_vm_readv`/`process_vm_writev`, `pidfd_getfd`), BPF, keyrings, module and kexec operations, quota control, perf, userfaultfd, io_uring, and file-preallocation bypasses. Legacy `clone` may not request namespace flags, and `clone3` fails with `ENOSYS` so libc falls back to legacy `clone`. A private network namespace has no host interfaces or routes. This is defense in depth, not VM-equivalent isolation or a guarantee against future kernel vulnerabilities.
