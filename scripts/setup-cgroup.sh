#!/usr/bin/env bash
# Usage: source scripts/setup-cgroup.sh <mount-directory>
# Mounts a private cgroup-v2 hierarchy, moves the calling shell into a service
# leaf, delegates cpu/memory/pids to a jobs subtree, and exports
# MICRO_SANDBOX_CGROUP_ROOT. Sourced so the caller's own PID is moved.
set -euo pipefail

cgroup_mount="${1:?cgroup mount directory is required}"
mkdir -p "$cgroup_mount"
mount -t cgroup2 none "$cgroup_mount"
mkdir "$cgroup_mount/service" "$cgroup_mount/jobs"
echo $$ > "$cgroup_mount/service/cgroup.procs"
echo '+cpu +memory +pids' > "$cgroup_mount/cgroup.subtree_control"
echo '+cpu +memory +pids' > "$cgroup_mount/jobs/cgroup.subtree_control"

export MICRO_SANDBOX_CGROUP_ROOT="$cgroup_mount/jobs"
