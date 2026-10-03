# Operations and verification

## Runtime prerequisites

- Linux 5.15+ on x64 or ARM64, with the required namespace, cgroup-v2, `clone3`, pidfd, mount, and seccomp facilities permitted by the host.
- Node.js 24.18+ as required by `package.json`. Native development uses Rust 1.97.1, Edition 2024.
- A dedicated service UID and private local workspace storage. Same-UID host processes are trusted; do not share that UID with untrusted services.
- A writable, dedicated cgroup-v2 subtree with `cpu`, `memory`, and `pids` delegated. With systemd, configure `Delegate=cpu memory pids` and provision an empty child subtree for sandbox jobs. Setting the option does not create delegation.
- A caller-owned runtime containing the desired executable and its dependencies under the mounted runtime directories. Tools needing configuration outside those directories need a compatible runtime arrangement.

Pass `cgroupRoot` or set `MICRO_SANDBOX_CGROUP_ROOT`. An explicit option takes precedence. `workspaceRoot` selects caller-owned storage; otherwise the instance creates and removes its private temporary root. Job subdirectories are removed before their promises settle. Provide enough disk space for concurrent declared budgets and the 20% reserve.

`supervisorBinary` or `MICRO_SANDBOX_BINARY` selects an explicit trusted supervisor executable. Otherwise the package resolves the optional platform binary. Windows cannot execute Linux sandbox jobs.

## Request lifecycle

Register runtimes and profiles before the supervisor starts. Both convenience methods and direct registry methods enforce the configuration lock. `run()` starts the supervisor lazily; instance creation alone does not establish isolation or probe the host.

The Node queue defaults to 32 active jobs and 100 waiting jobs. `maxInFlight` is limited to 64, `maxQueue` to 10,000. `overload: 'reject'` rejects when all active slots are occupied; `'wait'` queues until the queue bound is reached. Native live resource admission may still reject an admitted Node request.

`run()` validates and snapshots the request when it is called (command, runtime, profile, limits, arguments, environment, stdin, and artifact declarations) and reports every failure, including an invalid request, as a rejected promise. Unknown keys in resource or artifact limits, profiles, defaults, or ceilings are rejected with `POLICY_VIOLATION`. Profiles are shape-checked by `defineProfile()`; operator ceilings still apply per run.

`close()` stops accepting requests, drains queued and active work, waits for supervisor shutdown, and removes an instance-owned workspace root. Repeated calls share completion. Shutdown closes the supervisor's stdin so it can cancel, reap, and clean up its jobs, then escalates to `SIGTERM` and `SIGKILL` if it does not exit. A supervisor that failed to start owns nothing: its error is reported to the triggering request, `close()` does not rethrow it, and the next request starts a fresh supervisor.

Abort a job with its `AbortSignal`. An abort while the supervisor is starting settles the request immediately with `CANCELLED`. A running request retains its slot until cancellation is acknowledged or supervisor cleanup finishes; if the supervisor does not acknowledge within a bounded grace period it is retired, and the request settles with `CANCELLED` once the retired supervisor has closed. Supervisor startup has a bounded health check. A failed supervisor is retired before the affected request settles; later requests may create a replacement.

`timeoutMs` applies to native job execution and setup. Time spent in the Node queue or staging an input stream is outside that deadline. Use an `AbortSignal` for an end-to-end deadline, and ensure custom iterable producers stop when their supplied signal aborts. Treat request objects, buffers, and configuration as immutable while in use.

## Artifact contract

Inputs accept bytes, a regular single-link source file, a destroyable stream, or a cancellation-aware iterable factory; exactly one source must be defined, and streamed chunks must be strings or `Uint8Array`s. Paths are normalized relative POSIX file paths, and no path may also be another path's parent directory (for example `a` and `a/b`). A missing or unreadable source file or output is a `POLICY_VIOLATION` with the original error as `cause`; failures of the host workspace itself are `INTERNAL_ERROR`. The guest reads `/input` and writes predeclared files under `/output`; it cannot create additional output files or replace output directories.

All declared outputs must resolve to the same `maxBytes`. Each defaults to `limits.outputFileBytes`; explicit uniform per-output maxima may be smaller. The sum of the resolved maxima must fit `limits.outputBytes`. The launcher applies that uniform maximum through `RLIMIT_FSIZE` and blocks preallocation bypasses.

Output slots are pre-created. A required empty slot is a valid empty artifact, so presence does not prove a tool produced useful content. `required: false` omits untouched empty slots. Check `exitCode`, timeout/OOM/output-limit flags, and the actual file format before using results. Tool failure is represented by result status when collection succeeds; collection or isolation failures reject the promise.

Rust validates output files after the guest is gone. Node independently checks declarations, required entries, paths, type, links, size, aggregate bytes, and hashes. Results are buffered in memory; choose limits suitable for concurrent workloads.

## Local verification

Run from the repository root. Docker Desktop with Linux containers supplies native checks on Windows. The kernel and integration commands start disposable privileged containers and configure private cgroup namespaces inside them.

```sh
npm ci
npm test
npm run test:native
npm run build:native:docker -- --current=x64
npm run test:kernel
npm run test:integration
npm run package:verify -- --current=x64
npm run package:smoke -- --current=x64
npm run package:smoke:pnpm -- --current=x64
npm audit --audit-level=moderate
```

Use `--current=arm64` on ARM64. Omit the selector to build or verify both platform artifacts where supported. Cross-building a binary alone does not verify execution on that architecture.

| Check | Evidence it provides |
|---|---|
| `npm test` | TypeScript build and Node unit/contract regressions. Native execution is replaced only at the requester boundary in API tests. |
| `test:native` | Rust formatting, Clippy, and unprivileged Rust tests. Privileged tests require the kernel gate. |
| `test:kernel` | Actual namespace, mount, cgroup, cancellation, timeout, and supervisor lifecycle behavior. |
| `test:integration` | Public Node API through the built platform binary, including large artifacts and cleanup. |
| Package verification/smokes | Package metadata, static ELF shape, executable archive permissions, and npm/pnpm clean installations that compare the installed native binary's SHA-256 with the build and execute it. |
| `npm audit` | npm dependency advisories, not a Rust dependency or sandbox security audit. |

CI runs native and kernel checks on x64 and ARM64. The release workflow defines publication gates; [the audit record](intents/0001-audit-and-refactor.md) records which checks actually ran for this change.

## Release preparation

Synchronize the main package, both platform packages, and root optional-dependency requirements before releasing a new version. Published optional dependencies need matching lockfile version, registry URL, and integrity metadata. An unpublished platform version can use a lockfile entry containing only `"optional": true`, together with its exact root requirement; omitting the entry prevents `npm ci` from bootstrapping that version. Refresh registry metadata after publication.

```sh
npm run release:version -- 0.0.7
```

This sets the version in `package.json` (including both optional dependencies), both `npm/*/package.json` manifests, `native/Cargo.toml`, the `micro-sandbox-native` entry of `native/Cargo.lock`, and the root entries of `package-lock.json`. A platform lockfile entry whose metadata does not already match the new version becomes the `"optional": true` placeholder. `package:verify` and `release:verify` reject any version drift between these files.

Build the selected native binaries before packing. Docker images used by the build, test, and packaging helpers are pinned by tag and multi-architecture index digest in `scripts/lib/platforms.mjs`; update the tag and digest together (`docker buildx imagetools inspect <image:tag>`). On Windows, the package helpers pack platform archives inside Linux so the executable retains mode `0755`; packing those directories directly with Windows npm loses that mode. npm and pnpm can repair executable permissions during installation, so their success alone does not establish the archive contract.

```sh
npm run release:publish-local -- --main-only --dry-run
```

This prepares a fresh main-package tarball in `artifacts/` without authentication or publication. Use `--all --dry-run` to prepare all three packages after building both native binaries. The local publication helper requires a clean working tree (`--allow-dirty` is accepted only with `--dry-run`), runs package verification, and stages all selected packages before publishing those exact tarballs; it does not reuse cached tarballs. When platform packages are selected, it installs each staged platform tarball with the main tarball and checks the native SHA-256 and `--version` before anything is published; ARM64 runs under emulation on an x64 host.

Both the local helper and the hosted workflow treat an already published version as success only when the registry `dist.integrity` equals the local tarball's SHA-512 integrity; a mismatch fails the publication. A synchronized new version is needed to publish changed contents; an existing registry version cannot be replaced.

The hosted release workflow uploads each platform tarball from its own architecture job and the main tarball from the x64 job only, each with a `SHA256SUMS-<arch>` file. The publication job verifies that every expected tarball is covered by exactly one checksum file before publishing. Only that job receives `id-token: write`, and runs for the same tag are serialized. `npm audit` is advisory in the release workflow so that new advisories do not block reruns of an existing tag; CI keeps it blocking.

GitHub Actions does not read a developer's `.bashrc`. Store the npm token as `NPM_TOKEN` in this repository's `npm` environment. The publication script checks authentication explicitly, including reruns where all packages already exist. Its scripts use Node built-ins and do not need dependency installation.

After publication, refresh optional-dependency metadata with `npm install --package-lock-only --ignore-scripts` and commit the lockfile. Unpublished placeholders stop satisfying `npm ci` once those versions become available. To recover without moving a published tag, manually run the Release workflow from a branch whose commit is the tag commit or a descendant of it that differs only in `package-lock.json`, passing the existing tag (for example, `v0.0.6`). `release:verify` rejects any other branch state. The run repeats both architecture gates and skips packages whose published integrity matches the rebuilt tarballs.

## Failure diagnosis

| Failure | First check |
|---|---|
| `UNSUPPORTED_PLATFORM` | Host OS and architecture; actual execution requires Linux. |
| `CGROUP_DELEGATION_REQUIRED` | Explicit cgroup option/environment and delegated subtree permissions. |
| `ISOLATION_UNAVAILABLE` or `CGROUP_ERROR` | Kernel support, namespace restrictions, controller delegation, and supervisor error details. |
| `CAPACITY_EXCEEDED` | Node queue saturation, live ancestor resource headroom, and workspace free space. |
| `POLICY_VIOLATION` | Paths, registration, byte/file limits, artifact declarations, and supplied overrides. |
| `PROTOCOL_ERROR` or `SUPERVISOR_UNAVAILABLE` | Trusted binary version, process exit details, and transport failure. Malformed supervisor output is a `PROTOCOL_ERROR` that retires the supervisor, so the affected requests see `SUPERVISOR_UNAVAILABLE` with it as `cause`. A control frame that a request makes larger than 1 MiB is a `POLICY_VIOLATION`. |

Do not interpret an empty result or exit code alone as semantic validation. The sandbox contains execution; the caller owns transformation correctness.
