use serde::{Deserialize, Serialize};

pub const MAX_RAW_IO_BYTES: u64 = 512 * 1024;

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
}
