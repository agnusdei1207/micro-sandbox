use crate::error::SandboxError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceSnapshot {
    pub memory_limit_bytes: Option<u64>,
    pub memory_current_bytes: u64,
    pub cpu_limit_millis: Option<u64>,
    pub pids_limit: Option<u64>,
    pub pids_current: u64,
}

impl ResourceSnapshot {
    pub fn memory_headroom_bytes(self) -> Option<u64> {
        self.memory_limit_bytes
            .map(|limit| limit.saturating_sub(self.memory_current_bytes))
    }

    pub fn pid_headroom(self) -> Option<u64> {
        self.pids_limit
            .map(|limit| limit.saturating_sub(self.pids_current))
    }
}

pub fn parse_limit(value: &str) -> Result<Option<u64>, SandboxError> {
    let value = value.trim();
    if value == "max" {
        return Ok(None);
    }
    value.parse::<u64>().map(Some).map_err(|_| {
        SandboxError::InvalidCgroupValue(format!(
            "expected non-negative integer or max, got {value:?}"
        ))
    })
}

pub fn parse_cpu_max(value: &str) -> Result<Option<u64>, SandboxError> {
    let mut fields = value.split_whitespace();
    let quota = fields
        .next()
        .ok_or_else(|| SandboxError::InvalidCgroupValue("cpu.max is empty".into()))?;
    let period = fields
        .next()
        .ok_or_else(|| SandboxError::InvalidCgroupValue("cpu.max period is missing".into()))?
        .parse::<u64>()
        .map_err(|_| SandboxError::InvalidCgroupValue("cpu.max period is invalid".into()))?;
    if period == 0 || fields.next().is_some() {
        return Err(SandboxError::InvalidCgroupValue(
            "cpu.max must contain quota and a non-zero period".into(),
        ));
    }
    if quota == "max" {
        return Ok(None);
    }
    let quota = quota
        .parse::<u64>()
        .map_err(|_| SandboxError::InvalidCgroupValue("cpu.max quota is invalid".into()))?;
    Ok(Some(quota.saturating_mul(1000) / period))
}
