#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "$0")/setup-cgroup.sh" /tmp/micro-sandbox-node-cgroup

case "$(uname -m)" in
  x86_64) package_arch=x64 ;;
  aarch64|arm64) package_arch=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
export MICRO_SANDBOX_BINARY="/work/npm/linux-${package_arch}/bin/micro-sandbox"

exec node --test test/integration/*.spec.ts
