#!/usr/bin/env bash
set -euo pipefail

mkdir -p /tmp/micro-sandbox-node-cgroup
mount -t cgroup2 none /tmp/micro-sandbox-node-cgroup
mkdir /tmp/micro-sandbox-node-cgroup/service /tmp/micro-sandbox-node-cgroup/jobs
echo $$ > /tmp/micro-sandbox-node-cgroup/service/cgroup.procs
echo '+cpu +memory +pids' > /tmp/micro-sandbox-node-cgroup/cgroup.subtree_control
echo '+cpu +memory +pids' > /tmp/micro-sandbox-node-cgroup/jobs/cgroup.subtree_control

export MICRO_SANDBOX_CGROUP_ROOT=/tmp/micro-sandbox-node-cgroup/jobs
export MICRO_SANDBOX_BINARY=/work/npm/linux-x64/bin/micro-sandbox

exec node --test test/integration/*.spec.ts
