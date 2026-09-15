# Glossary

| Term | Meaning |
|---|---|
| Sandbox | Node instance that owns admission, its supervisor connection, and job workspaces. |
| Job | One request to run a command and collect its bounded result. |
| Supervisor | Long-lived Rust process that admits jobs, starts launchers, correlates responses, and handles cancellation. |
| Launcher | Fresh single-threaded Rust process that constructs one guest and collects its result. |
| Guest | Isolated command and descendants sharing the host Linux kernel. |
| Runtime | Immutable registration of an ID, host root filesystem, and guest entrypoint. |
| Profile | Named reusable resource-limit overrides, optionally inherited from another profile. |
| Ceiling | Upper policy bound. An operator ceiling and an immutable native bound are separate checks. |
| Delegated cgroup | Writable cgroup-v2 subtree provided by the operator for job resource control. |
| Workspace | Private host directory containing staged inputs and declared output files for one job. |
| Artifact | File transferred through the workspace rather than stdin/stdout or control frames. |
| Manifest | Paths, byte sizes, and SHA-256 digests returned by Rust for Node to verify independently. |
| Control frame | One bounded, newline-delimited JSON protocol message. |
| Fail closed | Reject execution when mandatory isolation cannot be established. |

For responsibilities and data flow, see the [architecture](ARCHITECTURE.md).
