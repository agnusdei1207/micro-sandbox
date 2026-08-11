# General-Purpose Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading in-process sanitizer with a fail-closed, general-purpose Linux sandbox distributed through npm for Linux 5.15+ on x86-64 and ARM64.

**Architecture:** A typed TypeScript client owns a long-lived Rust supervisor child. The supervisor performs admission control and creates a disposable namespace/cgroup/seccomp-isolated process for every job. Sanitization is a preset built on the same job API.

**Tech Stack:** TypeScript/Node.js 20+, Rust 2021, Tokio, serde, libc/nix, cgroup v2, clone3, seccomp BPF, Node test runner, Cargo tests, GitHub Actions, npm platform packages.

## Global Constraints

- Support only Linux kernel 5.15+ on x86-64 and ARM64.
- Fail closed when mandatory isolation is unavailable; never claim fallback isolation.
- Keep core security controls non-disableable while allowing safe defaults, ceilings, profiles, runtimes, and job overrides.
- Keep files focused by responsibility and remove obsolete implementation paths.
- Keep `README.md` short: value, support, install, runnable example, customization, architecture links.
- Keep architecture documentation in `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE.ko.md` with matching structure.
- Use the repository's configured Git author and never add Codex attribution.

---

### Task 1: TypeScript contracts, policy resolution, and errors

**Files:**
- Create: `src/types.ts`, `src/errors.ts`, `src/policy/defaults.ts`, `src/policy/resolve.ts`
- Create: `test/policy.spec.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces `SandboxOptions`, `JobRequest`, `JobResult`, `ResourceLimits`, `SandboxError`, `resolvePolicy()`.

- [ ] Write tests proving defaults, ceiling rejection, immutable isolation settings, safe path normalization, and stable error codes.
- [ ] Run `npm test` and confirm the new tests fail because the modules do not exist.
- [ ] Implement immutable typed contracts and pure policy resolution without process or filesystem access.
- [ ] Run `npm test` and confirm all policy tests pass.
- [ ] Commit with `feat: add sandbox policy contracts`.

### Task 2: Versioned supervisor protocol and testable client transport

**Files:**
- Create: `src/supervisor/protocol.ts`, `src/supervisor/transport.ts`, `src/supervisor/client.ts`, `src/platform/binary.ts`
- Create: `test/protocol.spec.ts`, `test/client.spec.ts`

**Interfaces:**
- Consumes `JobRequest`, `JobResult`, and `SandboxError`.
- Produces `SupervisorTransport`, `SupervisorClient`, `encodeFrame()`, `decodeFrame()`, and `resolveSupervisorBinary()`.

- [ ] Write tests for bounded newline-delimited frames, request correlation, concurrent responses, malformed messages, crash rejection, and Linux x64/ARM64 binary selection.
- [ ] Run the focused tests and verify missing modules fail.
- [ ] Implement a dependency-injected transport and a child-process transport with `shell: false`, bounded buffers, heartbeat, and deterministic close.
- [ ] Run the focused tests and the full TypeScript suite.
- [ ] Commit with `feat: add supervisor protocol client`.

### Task 3: Public Sandbox API and resource-aware queue UX

**Files:**
- Create: `src/api/sandbox.ts`, `src/api/runtime-registry.ts`, `src/api/profile-registry.ts`
- Create: `test/sandbox.spec.ts`, `test/registry.spec.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produces `createSandbox()`, `Sandbox.run()`, `Sandbox.close()`, `registerRuntime()`, `defineProfile()`, async disposal, and `AbortSignal` cancellation.

- [ ] Write API tests for lazy startup, bounded FIFO admission, overload rejection, cancellation, close/drain behavior, runtime digest validation, and profile inheritance.
- [ ] Verify tests fail before implementation.
- [ ] Implement the API as orchestration only; keep policy and IPC logic in their own modules.
- [ ] Run all TypeScript tests and type checking.
- [ ] Commit with `feat: add general sandbox api`.

### Task 4: Rust protocol, configuration, and capacity model

**Files:**
- Create: `native/Cargo.toml`, `native/src/main.rs`, `native/src/protocol.rs`, `native/src/error.rs`, `native/src/config.rs`, `native/src/resources.rs`, `native/src/scheduler.rs`
- Create: `native/tests/protocol.rs`, `native/tests/resources.rs`, `native/tests/scheduler.rs`

**Interfaces:**
- Consumes protocol v1 job, cancel, health, and shutdown messages.
- Produces correlated results, heartbeats, `ResourceSnapshot`, and atomic `Reservation` guards.

- [ ] Write Cargo tests for message bounds, validation, cgroup limit parsing, reservation races, FIFO fairness, pressure rejection, and reservation release on drop.
- [ ] Run `cargo test --manifest-path native/Cargo.toml` and confirm failure before implementation.
- [ ] Implement the smallest modules that satisfy the tests; use checked arithmetic and bounded collections.
- [ ] Run Cargo formatting, clippy with warnings denied, and all native tests.
- [ ] Commit with `feat: add rust supervisor core`.

### Task 5: Linux cgroup and process lifecycle

**Files:**
- Create: `native/src/linux/mod.rs`, `native/src/linux/cgroup.rs`, `native/src/linux/pidfd.rs`, `native/src/job.rs`
- Create: `native/tests/cgroup.rs`, `native/tests/lifecycle.rs`

**Interfaces:**
- Produces `Cgroup`, `PidFd`, `JobGuard`, `kill_and_reap()`, and cleanup verification.

- [ ] Write Linux-only tests against an injected temporary cgroup filesystem and syscall seams for limit writes, event parsing, descendant kill, timeout, cancellation, and idempotent cleanup.
- [ ] Run the tests and verify failure.
- [ ] Implement cgroup v2 discovery, delegated subtree checks, limit application, pidfd signaling, `cgroup.kill`, wait/reap, and cleanup guards.
- [ ] Run native unit tests, clippy, and Linux integration tests where supported.
- [ ] Commit with `feat: manage sandbox job resources`.

### Task 6: Namespace, filesystem, capability, and seccomp isolation

**Files:**
- Create: `native/src/linux/clone.rs`, `native/src/linux/mount.rs`, `native/src/linux/capabilities.rs`, `native/src/linux/seccomp.rs`, `native/src/linux/paths.rs`
- Create: `native/tests/isolation.rs`, `native/tests/escape.rs`

**Interfaces:**
- Produces `spawn_isolated(JobSpec, Cgroup)`, `IsolationReport`, verified input/output trees, and profile-specific syscall filters.

- [ ] Write Linux integration fixtures that attempt network access, host reads, path traversal, symlink escape, mount, ptrace, BPF, fork bombs, signal ignoring, and double fork.
- [ ] Confirm the fixtures fail or escape before the isolation engine is connected.
- [ ] Implement clone3 namespace creation with UID/GID synchronization and initial cgroup placement, private tmpfs root with `pivot_root`, read-only runtime/input mounts, output-only writable mount, FD closure, `no_new_privs`, capability removal, and seccomp BPF.
- [ ] Run the complete adversarial suite and verify no child, mount, or cgroup survives.
- [ ] Commit with `feat: isolate linux sandbox jobs`.

### Task 7: End-to-end supervisor job execution and recovery

**Files:**
- Modify: `native/src/main.rs`, `native/src/job.rs`, `src/supervisor/client.ts`
- Create: `test/integration/sandbox-linux.spec.ts`, `native/tests/faults.rs`

**Interfaces:**
- Connects protocol jobs to reservations and isolated execution; returns bounded streams, outputs, metrics, and isolation reports.

- [ ] Write tests for successful execution, nonzero exits, output limits, timeout, OOM, cancellation, supervisor crash, restart, concurrent capacity, and stale-resource reconciliation.
- [ ] Run tests to capture the incomplete behavior.
- [ ] Implement job orchestration with one cleanup path, heartbeat, fault mapping, and safe restart.
- [ ] Run TypeScript and Rust suites plus repeated-run leak tests.
- [ ] Commit with `feat: execute and recover sandbox jobs`.

### Task 8: Extensible sanitization pipeline and compatibility cleanup

**Files:**
- Create: `src/presets/sanitize/index.ts`, `src/presets/sanitize/types.ts`, `src/presets/sanitize/registry.ts`, `src/presets/sanitize/text.ts`, `src/presets/sanitize/html.ts`, `src/presets/sanitize/image.ts`, `src/presets/sanitize/svg.ts`, `src/presets/sanitize/pdf.ts`, `src/presets/sanitize/office.ts`, `src/presets/sanitize/archive.ts`, `src/presets/sanitize/detect.ts`, `src/presets/sanitize/budgets.ts`
- Create: `test/sanitize.spec.ts`
- Delete obsolete logic from: `src/index.ts`
- Modify: `package.json`

**Interfaces:**
- Preserves `sanitizeFile()`, `sanitizeText()`, `sanitizeHtmlDocument()`, and `sanitizeImage()` while routing unsafe parsers through the sandbox preset on supported hosts. Produces `SanitizationReport` with the detected type, strategy, fidelity loss, guarantees, warnings, and recursively processed entries.

- [ ] Write compatibility and hostile-input tests for MIME mismatch, malformed UTF-8, active HTML/SVG, image and decompression bombs, PDF JavaScript/actions/attachments, macro-enabled Office documents, OLE/external links, archive traversal, recursive archives, entry-count/expanded-size/ratio/depth budgets, and fail-closed isolation.
- [ ] Verify failures against the old implementation.
- [ ] Implement a processor registry with safe built-ins and operator-supplied processors registered only at startup. Re-encode raster images from decoded pixels; support animated frame budgets; rasterize SVG by default with strict structural mode as an explicit lower-guarantee option; rasterize PDF pages into a fresh image-only PDF; reject macro Office formats by default and allow sandboxed PDF conversion; recursively sanitize archives with normalized paths and hard budgets. Move pure validation into focused modules, remove fake `unshare --help` isolation, remove non-isolated fallback, and connect every parser to the sandbox API.
- [ ] Run the complete suite and scan for obsolete exports and dead dependencies.
- [ ] Commit with `refactor: rebuild sanitization on sandbox jobs`.

### Task 9: Platform packaging, CI, and release metadata

**Files:**
- Create: `npm/linux-x64/package.json`, `npm/linux-arm64/package.json`
- Create: `scripts/build-native.mjs`, `scripts/package-native.mjs`, `scripts/verify-package.mjs`
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Modify: `package.json`, `package-lock.json`, `.gitignore`, `tsconfig.json`

**Interfaces:**
- Produces reproducible platform packages and a main package that resolves the correct binary via optional dependencies.

- [ ] Write package-verifier tests for exports, files, executable mode, binary architecture, optional dependency versions, metadata, and clean-install smoke behavior.
- [ ] Verify the current package fails the checks.
- [ ] Add Linux x64/ARM64 build jobs, checksums, npm provenance, engines/os/cpu metadata, focused keywords, repository/homepage/bugs fields, and exact-version platform dependencies.
- [ ] Run `npm pack --dry-run` and install each tarball into an empty project.
- [ ] Commit with `build: package linux sandbox binaries`.

### Task 10: Documentation, strict review, and release

**Files:**
- Rewrite: `README.md`
- Update only if behavior changed: `docs/ARCHITECTURE.md`, `docs/ARCHITECTURE.ko.md`
- Delete: obsolete generated or source files found by review

**Interfaces:**
- Produces the user-facing package, concise usage documentation, and verified release artifacts.

- [ ] Rewrite README in the order: one-paragraph value, support, install, immediate example, customization, architecture links.
- [ ] Run formatting, type checking, unit, integration, adversarial, stress, leak, clippy, audit, package, and clean-install verification.
- [ ] Review every changed file for mixed responsibilities, unsafe defaults, silent fallback, duplicated logic, dead code, secret leakage, misleading claims, and architecture drift; refactor and rerun all checks.
- [ ] Commit with `docs: prepare micro-sandbox release`, keeping only the configured Git author.
- [ ] Push the branch, wait for CI on x86-64 and ARM64, fix any failure, and rerun release gates.
- [ ] Publish platform packages before the main package using the configured npm token and provenance where supported.
- [ ] Install the published version into a clean project, run smoke tests, verify npm metadata/search terms, and apply matching GitHub repository topics.
