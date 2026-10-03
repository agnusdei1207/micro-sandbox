# INTENT-0002: Lifecycle hardening, refactoring, and release integrity

- Status: corrections and refactoring complete; Linux x64 gates passed locally. ARM64 execution is covered by hosted CI and the release workflow.
- Created/updated: 2026-10-03
- Baseline: `19e1118` (`0.0.6`), clean working tree.

## Why and intended outcome

A second full-repository review found release-integrity gaps, supervisor-wide failure from single requests, lost native error codes, and duplicated helpers across Node, Rust, and release tooling. This change corrects those defects, consolidates the duplicated code, and ships as the `0.0.7` patch release.

## Acceptance criteria

- [x] A release run publishes only code from the release tag commit, or from a descendant that changes only `package-lock.json`.
- [x] Each tarball is staged by exactly one architecture job; already published versions are accepted only when their registry integrity matches.
- [x] A malformed request, signal failure, or slow cgroup cleanup no longer terminates the supervisor or its other jobs.
- [x] Launcher failures reach Node with their original error code.
- [x] Node rejects invalid input as a rejected promise with `POLICY_VIOLATION` before staging, including unknown limit keys and out-of-range CPU quotas.
- [x] Exported API and wire protocol remain backward compatible.

## Changes

| Area | Summary |
|---|---|
| Release | Tag-commit verification, single-owner main tarball, integrity-checked idempotent publication, per-job OIDC permission, per-tag concurrency, digest-pinned build images, `--locked` cargo runs, shared `scripts/lib` modules, `release:version` synchronizer. |
| Node API | Asynchronous validation, request snapshots, startup abort and health timeout, cancel acknowledgement deadline, close-after-drain transport shutdown, unknown-key rejection, centralized error helpers, linear frame decoding. |
| Supervisor | Per-request protocol failures, structured launcher errors, off-loop cleanup, corrected admission headroom, private random staging roots with reconciliation, event-driven main loop. |
| Isolation layer | No unwinding from the cloned child, errno captured at the syscall, wider seccomp deny list with a BPF interpreter test, CPU quota bounds, EINTR-safe handshakes, single pidfd/cgroup-removal/path helpers, one hardening sequence shared by probe and launcher. |

## Verification

| Gate | Result |
|---|---|
| `npm test` | Pass (Windows; the Linux container run also covers link and signal cases). |
| `test:native` | fmt, Clippy `-D warnings`, unprivileged Rust tests pass. |
| `test:kernel` | Privileged namespace, mount, cgroup, cancellation, and cleanup tests pass. |
| `test:integration` | Public API through the built x64 binary passes. |
| Package gates | x64 static ELF verification, npm and pnpm clean-install smokes pass. |
| Workflows | actionlint clean; hosted runs provide ARM64 and publication evidence. |

Linux validation used Docker on an x64 WSL2 kernel. Earlier assessment limits in [INTENT-0001](0001-audit-and-refactor.md) still apply.
