use serde::{Deserialize, Serialize};

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
            input_bytes: 25 * 1024 * 1024,
            output_bytes: 50 * 1024 * 1024,
        }
    }
}
