use serde::{Deserialize, Serialize};

pub const MAX_RAW_IO_BYTES: u64 = 512 * 1024;
/// cgroup v2 `cpu.max` period used for every job.
pub const CPU_PERIOD_MICROS: u64 = 100_000;
/// Smallest quota accepted by the kernel for `cpu.max`.
const MIN_CPU_QUOTA_MICROS: u64 = 1_000;
/// Upper bound on a job's CPU limit, expressed in CPUs.
const MAX_CPUS: f64 = 1_024.0;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceLimits {
    pub timeout_ms: u64,
    pub memory_mb: u64,
    pub cpu: f64,
    pub pids: u64,
    pub input_bytes: u64,
    pub output_bytes: u64,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            timeout_ms: 5_000,
            memory_mb: 256,
            cpu: 0.5,
            pids: 16,
            input_bytes: 64 * 1024,
            output_bytes: 256 * 1024,
        }
    }
}

impl ResourceLimits {
    pub fn validate_transport_bounds(self) -> Result<(), &'static str> {
        if self.input_bytes == 0 || self.input_bytes > MAX_RAW_IO_BYTES {
            return Err("input limit must be between 1 byte and 512 KiB");
        }
        if self.output_bytes == 0 || self.output_bytes > MAX_RAW_IO_BYTES {
            return Err("output limit must be between 1 byte and 512 KiB");
        }
        Ok(())
    }

    /// Returns the `cpu.max` quota for [`CPU_PERIOD_MICROS`], rejecting values the
    /// kernel would refuse or that cannot be represented exactly.
    pub fn cpu_quota_micros(self) -> Result<u64, &'static str> {
        if !self.cpu.is_finite() || self.cpu <= 0.0 || self.cpu > MAX_CPUS {
            return Err("CPU limit must be positive, finite, and at most 1024 CPUs");
        }
        let quota = (self.cpu * CPU_PERIOD_MICROS as f64).round() as u64;
        if quota < MIN_CPU_QUOTA_MICROS {
            return Err("CPU limit must be at least 0.01 CPUs");
        }
        Ok(quota)
    }
}
