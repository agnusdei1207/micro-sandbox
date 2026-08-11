#!/usr/bin/env bash
set -euo pipefail

mkdir -p /tmp/micro-sandbox-node-cgroup
mount -t cgroup2 none /tmp/micro-sandbox-node-cgroup
mkdir /tmp/micro-sandbox-node-cgroup/service /tmp/micro-sandbox-node-cgroup/jobs
echo $$ > /tmp/micro-sandbox-node-cgroup/service/cgroup.procs
echo '+cpu +memory +pids' > /tmp/micro-sandbox-node-cgroup/cgroup.subtree_control
echo '+cpu +memory +pids' > /tmp/micro-sandbox-node-cgroup/jobs/cgroup.subtree_control

export MICRO_SANDBOX_CGROUP_ROOT=/tmp/micro-sandbox-node-cgroup/jobs
case "$(uname -m)" in
  x86_64) package_arch=x64 ;;
  aarch64|arm64) package_arch=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
export MICRO_SANDBOX_BINARY="/work/npm/linux-${package_arch}/bin/micro-sandbox"

exec node --test test/integration/*.spec.ts
