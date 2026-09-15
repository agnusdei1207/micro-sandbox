# Project intent

## Purpose

Run caller-selected, untrusted Linux commands from Node.js through a small generic API. Keep transformation tools, media validation, storage, and application policy in the caller. Large input and output files travel through bounded artifact workspaces.

This records the existing implementation contract from the README and architecture guide. It does not add product requirements.

## Constraints and decisions

- Preserve the public Node API and versioned supervisor protocol during maintenance.
- Support Linux x64 and ARM64 execution; Windows supports package installation and development tests.
- Require namespaces, cgroup v2, a private filesystem root, capability removal, `no_new_privs`, and seccomp. Required isolation failures reject execution.
- Trust the Node application, supervisor, runtime root, delegated cgroup, and host processes sharing the service UID. The untrusted boundary is the guest command and its descendants.
- Keep runtimes as executable/root mappings and profiles as resource-limit layers. Neither loads code into the supervisor.
- Keep published documentation in English, consistent with the repository's existing documentation decision.

## Authorization

The current request authorizes a full code audit, documentation cleanup, and code refactoring. Follow-up instructions authorize committing and pushing these changes and preparing the `0.0.6` patch release through the tag-triggered release workflow. Changes to unrelated repositories remain outside scope. Future product changes require their own scope.

See the [structure map](../ARCHITECTURE.md), [terms](../GLOSSARY.md), and [audit intent](0001-audit-and-refactor.md).
