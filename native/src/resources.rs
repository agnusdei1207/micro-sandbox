use crate::error::SandboxError;
use crate::scheduler::Capacity;
use std::fs;
use std::path::Path;

const ADMISSION_PERCENT: u64 = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceSnapshot {
    pub memory_limit_bytes: Option<u64>,
    pub memory_current_bytes: u64,
    pub cpu_limit_millis: Option<u64>,
    pub pids_limit: Option<u64>,
    pub pids_current: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceFallbacks {
    pub memory_bytes: u64,
    pub cpu_millis: u64,
    pub pids: u64,
}

pub fn admission_capacity(snapshot: ResourceSnapshot, fallbacks: ResourceFallbacks) -> Capacity {
    Capacity {
        memory_bytes: reserve_margin(
            snapshot
                .memory_headroom_bytes()
                .unwrap_or(fallbacks.memory_bytes),
        ),
        cpu_millis: reserve_margin(snapshot.cpu_limit_millis.unwrap_or(fallbacks.cpu_millis)),
        pids: reserve_margin(snapshot.pid_headroom().unwrap_or(fallbacks.pids)),
    }
}

pub fn effective_admission_capacity(
    snapshots: &[ResourceSnapshot],
    fallbacks: ResourceFallbacks,
) -> Capacity {
    snapshots.iter().copied().fold(
        admission_capacity(
            ResourceSnapshot {
                memory_limit_bytes: None,
                memory_current_bytes: 0,
                cpu_limit_millis: None,
                pids_limit: None,
                pids_current: 0,
            },
            fallbacks,
        ),
        |effective, snapshot| {
            let capacity = admission_capacity(snapshot, fallbacks);
            Capacity {
                memory_bytes: effective.memory_bytes.min(capacity.memory_bytes),
                cpu_millis: effective.cpu_millis.min(capacity.cpu_millis),
                pids: effective.pids.min(capacity.pids),
            }
        },
    )
}

pub fn detect_admission_capacity(cgroup_root: &Path) -> Result<Capacity, SandboxError> {
    let mut snapshots = Vec::new();
    let mut current = Some(cgroup_root);
    while let Some(path) = current {
        if !path.join("cgroup.controllers").exists() {
            break;
        }
        snapshots.push(read_snapshot(path)?);
        current = path.parent();
    }
    if snapshots.is_empty() {
        return Err(SandboxError::CgroupUnavailable(format!(
            "{} has no readable cgroup controllers",
            cgroup_root.display()
        )));
    }
    Ok(effective_admission_capacity(&snapshots, host_fallbacks()?))
}

fn read_snapshot(cgroup: &Path) -> Result<ResourceSnapshot, SandboxError> {
    Ok(ResourceSnapshot {
        memory_limit_bytes: parse_limit(&fs::read_to_string(cgroup.join("memory.max"))?)?,
        memory_current_bytes: parse_number(&fs::read_to_string(cgroup.join("memory.current"))?)?,
        cpu_limit_millis: parse_cpu_max(&fs::read_to_string(cgroup.join("cpu.max"))?)?,
        pids_limit: parse_limit(&fs::read_to_string(cgroup.join("pids.max"))?)?,
        pids_current: parse_number(&fs::read_to_string(cgroup.join("pids.current"))?)?,
    })
}

fn host_fallbacks() -> Result<ResourceFallbacks, SandboxError> {
    let memory_bytes = fs::read_to_string("/proc/meminfo")?
        .lines()
        .find_map(|line| line.strip_prefix("MemAvailable:"))
        .and_then(|value| value.split_whitespace().next())
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|kilobytes| kilobytes.checked_mul(1024))
        .ok_or_else(|| SandboxError::InvalidCgroupValue("MemAvailable is invalid".into()))?;
    let cpu_millis = u64::try_from(std::thread::available_parallelism()?.get())
        .unwrap_or(u64::MAX)
        .saturating_mul(1000);
    let pid_max = parse_number(&fs::read_to_string("/proc/sys/kernel/pid_max")?)?;
    let task_count = fs::read_dir("/proc")?
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .as_encoded_bytes()
                .iter()
                .all(u8::is_ascii_digit)
        })
        .map(|entry| {
            fs::read_dir(entry.path().join("task")).map_or(0, |tasks| tasks.count() as u64)
        })
        .sum::<u64>();
    Ok(ResourceFallbacks {
        memory_bytes,
        cpu_millis,
        pids: pid_max.saturating_sub(task_count),
    })
}

fn reserve_margin(value: u64) -> u64 {
    value.saturating_mul(ADMISSION_PERCENT) / 100
}

fn parse_number(value: &str) -> Result<u64, SandboxError> {
    value.trim().parse().map_err(|_| {
        SandboxError::InvalidCgroupValue(format!("expected non-negative integer, got {value:?}"))
    })
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
