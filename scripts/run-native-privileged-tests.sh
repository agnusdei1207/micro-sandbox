#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/setup-cgroup.sh" /tmp/micro-sandbox-cgroup

exec cargo test --locked --jobs 2 --manifest-path native/Cargo.toml \
  --test namespace \
  --test job_cli \
  --test security \
  --test supervisor_run \
  --test supervisor_cli \
  -- --nocapture --include-ignored
