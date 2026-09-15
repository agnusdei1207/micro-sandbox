# INTENT-0001: Implementation audit and refactoring

- Status: audit, corrections, refactoring, and documentation complete for the reviewed scope; Linux x64 execution gates passed. ARM64 execution and hosted publication remain unverified.
- Created/updated: 2026-09-15
- Baseline: `46d27cb` (`0.0.5`), initially clean working tree.

## Why and intended outcome

Audit the entire repository against its stated sandbox contract, correct reproducible defects, simplify responsibility boundaries, and organize documentation so implementation status can be assessed without reading the code.

The requested `../memory` directory was absent. The adjacent `../my-memory` repository supplied the development methodology through `skills/dev/build-software/SKILL.md`, its intent/refactoring references, and technical-documentation guidance. Those are process references; this project's behavior is defined by its own API, code, and tests.

## Acceptance criteria

- [x] Account for every baseline tracked source, test, example, script, workflow, configuration, and document using the same boundary/lifecycle/limit/cleanup criteria.
- [x] Reproduce confirmed defects with regression tests and verify their corrections.
- [x] Preserve exported API/protocol compatibility while separating policy from I/O and eliminating duplicated rules.
- [x] Run Node, native, privileged Linux, public API integration, and applicable package gates; report architecture coverage and unexecuted gates explicitly.
- [x] Keep purpose, terminology, structure, operations, and audit evidence in linked documents with one owner per topic.

## Constraints

Preserve required isolation. No new product features or unrelated repository changes. Subsequent user instructions authorize commit, push, and the `0.0.6` patch release; the verification record below describes the pre-release audit. Keep the repository's English documentation convention. Tests and review establish observed behavior, not a proof that all possible kernel or sandbox vulnerabilities are absent.

## AI assessment

### Review coverage

The baseline contains 83 tracked files. Generated lockfiles were checked as dependency/release metadata; executable files were reviewed by data flow, ownership, validation, cancellation, cleanup, and test reachability.

| Baseline group | Review scope |
|---|---|
| `src/` (16 files) | Every API, registry, result decoder, workspace, platform, policy, transport, protocol, error, and type module. |
| `native/src/` (18 files) | CLI/library/config/error, supervisor/job, resources/scheduler, artifacts, and all Linux isolation modules. |
| `test/` (9 files) | Every Node suite, including public API Linux integration. |
| `native/tests/` (11 files) | Every native test suite and privilege gating. Inline native tests are included with their source files. |
| `scripts/` (12 files) | Build, cleanup, native runners, verification, packed installation, and publication helpers. |
| Examples/workflows/platform manifests (6 files) | Both recipes, both CI/release workflows, both npm platform manifests. |
| Root/native metadata and docs (11 files) | README, architecture, license, package/Cargo manifests and lockfiles, TypeScript config, Node pin, Git configuration files. |

### Confirmed defects and corrections

| Area | Before | Correction/evidence |
|---|---|---|
| Supervisor loss | Guest could clear `PR_SET_PDEATHSIG` and survive forced supervisor loss. | Seccomp regression and actual guest/supervisor death test passed, including empty cgroup before any restart. |
| Mapping handshake | Initial child readiness could block beyond the job deadline. | Shared deadline-aware readiness wait for user mapping and security setup; real pipe/process regression. |
| Resource discovery | Walking to the real cgroup hierarchy root required limit files that do not exist there. | Root-aware ancestor discovery, retaining validation on delegated child groups. |
| Cancellation race | Signalling an already reaped launcher returned `ESRCH` and could tear down unrelated jobs. | Idempotent pidfd termination and reaped-process regression. |
| Native response bound | A valid launcher JSON result could exceed the frame limit after its response envelope was added, terminating the supervisor. | Validate the full envelope and return a correlated job error; verify the next response remains writable. |
| Node transport lifecycle | Failed clients skipped transport close; concurrent closes could return before cleanup. | One close promise shared by every caller, including failed clients. |
| Undeliverable cancellation | Failed cancel writes released a request while its guest could still run. | Close the transport and retain pending requests until cleanup. |
| Supervisor replacement | Failed requester references were discarded without cleanup, and stale failures could clear a replacement. | Retire the failed requester and compare requester identity before resetting the current generation. |
| Workspace cleanup | A supervisor close error prevented removal of an owned workspace root. | Independent cleanup through `finally`; regression checks removal after close rejection. |
| Manifest validation | Required outputs could be absent; malformed entries leaked `TypeError`. | Required-declaration checks and stable malformed-entry errors before exposing buffers. |
| Artifact names | Input `output:result` incorrectly collided with declared output `result`. | Separate input/output duplicate sets; reproduced and verified on Linux. |
| Control frame bound | A complete frame followed by an oversized unfinished fragment bypassed immediate rejection. | Validate the trailing buffer after processing complete frames. |
| Configuration lock | Direct registry mutation bypassed the Sandbox wrapper's lock. | Registry-owned monotonic locks used by both access paths. |
| Validation ordering | Invalid resource requests consumed input producers and started a supervisor first. | Resolve policy and stdin byte limits before staging/startup. |
| Runtime entrypoint | Registered runtime paths had weaker validation than direct commands. | Reuse the guest-path rule for both entrypoints. |
| Recipes | Default recipes referenced unregistered runtimes; image input overrides left the per-file cap unchanged. | Remove implicit runtime registration requirements and propagate the per-file input bound; exercise recipes through `Sandbox.run()`. |
| CLI selectors | Unknown/empty architecture selectors could skip native work and report success; unknown native modes ran the default suite. | Reject invalid selectors and modes before invoking Docker, with CLI regression tests. |
| Release artifact | Publication rebuilt the main package instead of using the tested tarball; platform selection matched version prefixes. | Select exact tarball names for every package and verify downloaded checksums before publication. |
| Installation probes | pnpm smoke only imported the API; binary resolution/execution was untested, and an existing registry version could mask the local artifact. | Shared probes resolve from the installed main package, compare SHA-256 with the build, and execute its version command; pnpm overrides select the exact local artifact. |
| Native test reporting | Privileged tests returned early and were reported as passed; the kernel runner omitted the security suite. | Explicit ignored tests in the default gate; include security and ignored tests in the privileged gate. |
| Platform archive permissions | Packing from Windows stored the native executable as `0644`; Yarn PnP could not execute it. | Linux staging preserves `0755`; a permanent archive check rejects `0644`. Yarn 4.9.2 PnP passed with exact local resolution and binary hash verification. |
| Local publication | Same-version cached tarballs could be reused, and main publication rebuilt from the directory. | Stage all selected fresh packages and publish exact tarballs; a dry-run regression replaces a stale artifact without registry access. |
| Next-version bootstrap | Lock validation required published metadata, preventing preparation of unpublished platform versions. | Accept exact-root optional placeholders or complete matching registry metadata; real `npm ci` fixtures confirmed the bootstrap shape, and contract tests cover both forms. |

### Refactoring

- Artifact defaults and override resolution moved to `src/policy/artifacts.ts`; filesystem ownership remains in the workspace module.
- Request payload preparation is separate from asynchronous execution/cleanup.
- Required isolation keys come from the policy definition instead of a second hand-maintained list.
- Duplicate workspace removal wrappers were consolidated.
- Native setup stages share one deadline-aware readiness helper; release paths share tarball selection and installed-binary probes.
- Public exports and protocol version remain unchanged; direct registry mutation now honors the documented lock.

### Verification record

| Check | Observed result |
|---|---|
| Baseline Windows `npm test` | 40 passed on Node 24.14.1; below the declared minimum, so not the supported-runtime gate. |
| Baseline Docker `test:native` | Format and Clippy passed. 35 reported passing tests included 14 silent privileged early returns; 21 actually exercised. |
| New Node regressions | Expected failures observed before fixes for lifecycle, cancellation, frame bounds, validation ordering, registry, and manifest defects. |
| Linux artifact regressions | 4 passed on Node 24.18.0, including the input/output name collision. |
| Final Windows `npm test` | 64 passed, 1 explicit Linux-only filename skip; TypeScript build passed on Node 24.14.1. |
| Supported Linux Node gate | Clean Docker installation on Node 24.18.0, TypeScript build, and all 65 tests passed with zero skips. Linux dependencies were installed inside the container instead of reusing Windows TypeScript binaries. |
| Final native default gate | Rustfmt and Clippy with denied warnings passed; 26 tests executed, 15 explicitly ignored. |
| Linux privileged gate | Final code: 16 passed, zero ignored; includes one unprivileged seccomp regression also covered by the default gate. Together the gates exercised all 41 unique native tests. |
| Public API integration | Final Linux x64 binary passed: command execution, 5 MiB artifact round trip, threads, cancellation, eight concurrent jobs, and empty job cgroups. |
| npm audit | 0 vulnerabilities reported for npm dependencies. |
| Independent Node review | No blocking findings; no-emit typecheck and an independent concurrent replacement reproduction passed. |
| Independent release-helper review | No blocking findings; 10 focused tests passed, and both the JavaScript guard and an independent tar listing confirmed native mode `0755`. |
| Documentation links | 6 Markdown files and 16 relative links validated. |
| Package gates | Static musl x64 build, package/ELF verification, executable tar-member validation, and release metadata verification passed. npm and pnpm 12.4.1 clean-install probes passed with exact binary SHA-256 and execution checks. Manual Yarn 4.9.2 PnP with an explicit local resolution also passed. Publication was not performed. |

### Limits of the assessment

- Linux validation used Docker on x64 with kernel `6.6.87.2-microsoft-standard-WSL2`. ARM64 execution, the minimum advertised Linux 5.15 kernel, and hosted GitHub release workflows require separate evidence.
- The native kernel boundary is not VM isolation. Trusted host/runtime/supervisor assumptions remain required.
- Queue waiting and artifact staging are outside the native execution timeout; callers need cancellation for an end-to-end deadline.
- Multi-supervisor reservations are local, although all supervisors observe live cgroup headroom. There is no cross-process atomic admission reservation.
- Required output files are pre-created; an empty required artifact does not prove a transformation succeeded.
- Installation checks used local platform tarballs; automatic registry selection of a newly published version was not exercised. Yarn PnP was checked manually and is not an automated CI gate.
- Docker image tags and the Corepack-selected pnpm version are not immutable build inputs; these results do not establish bit-for-bit reproducibility.

All confirmed defects above were corrected and verified within this scope. Follow-up release preparation synchronizes Node, platform, and Rust package versions at `0.0.6`. The tag-triggered workflow must pass both architecture gates before publication; this audit record does not itself establish ARM64 runtime certification or successful publication.
