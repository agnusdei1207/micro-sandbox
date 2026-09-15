#!/usr/bin/env bash
set -euo pipefail

mkdir -p /tmp/micro-sandbox-cgroup
mount -t cgroup2 none /tmp/micro-sandbox-cgroup
mkdir /tmp/micro-sandbox-cgroup/service /tmp/micro-sandbox-cgroup/jobs
echo $$ > /tmp/micro-sandbox-cgroup/service/cgroup.procs
echo '+cpu +memory +pids' > /tmp/micro-sandbox-cgroup/cgroup.subtree_control
echo '+cpu +memory +pids' > /tmp/micro-sandbox-cgroup/jobs/cgroup.subtree_control

export MICRO_SANDBOX_CGROUP_ROOT=/tmp/micro-sandbox-cgroup/jobs

exec cargo test --jobs 2 --manifest-path native/Cargo.toml \
  --test namespace \
  --test job_cli \
  --test security \
  --test supervisor_run \
  --test supervisor_cli \
  -- --nocapture --include-ignored
