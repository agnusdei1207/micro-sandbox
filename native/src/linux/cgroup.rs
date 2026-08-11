use crate::config::ResourceLimits;
use crate::error::SandboxError;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const CGROUP2_SUPER_MAGIC: libc::c_long = 0x6367_7270;
const PERIOD_MICROS: u64 = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CgroupMode {
    Kernel,
    Emulated,
}

#[derive(Debug)]
pub struct Cgroup {
    path: PathBuf,
    mode: CgroupMode,
    cleaned: bool,
}

impl Cgroup {
    pub fn create(
        delegated_root: &Path,
        job_id: &str,
        limits: ResourceLimits,
    ) -> Result<Self, SandboxError> {
        Self::create_in(delegated_root, job_id, limits, CgroupMode::Kernel)
    }

    pub fn create_in(
        delegated_root: &Path,
        job_id: &str,
        limits: ResourceLimits,
        mode: CgroupMode,
    ) -> Result<Self, SandboxError> {
        validate_job_id(job_id)?;
        validate_limits(limits)?;
        if mode == CgroupMode::Kernel {
            verify_cgroup2(delegated_root)?;
        }
        let path = delegated_root.join(job_id);
        fs::create_dir(&path).map_err(|error| {
            SandboxError::CgroupUnavailable(format!("cannot create {}: {error}", path.display()))
        })?;
        let mut cgroup = Self {
            path,
            mode,
            cleaned: false,
        };
        if let Err(error) = cgroup.configure(limits) {
            let _ = cgroup.cleanup();
            return Err(error);
        }
        Ok(cgroup)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn attach(&self, pid: i32) -> Result<(), SandboxError> {
        if pid <= 0 {
            return Err(SandboxError::PolicyViolation("PID must be positive".into()));
        }
        self.write("cgroup.procs", &pid.to_string())
    }

    pub fn cleanup(&mut self) -> Result<(), SandboxError> {
        if self.cleaned {
            return Ok(());
        }
        if !self.path.exists() {
            self.cleaned = true;
            return Ok(());
        }

        let kill_result = self.write("cgroup.kill", "1");
        if self.mode == CgroupMode::Emulated {
            for entry in fs::read_dir(&self.path)? {
                let path = entry?.path();
                if path.is_file() {
                    fs::remove_file(path)?;
                }
            }
        }
        fs::remove_dir(&self.path)?;
        self.cleaned = true;
        kill_result
    }

    fn configure(&self, limits: ResourceLimits) -> Result<(), SandboxError> {
        let memory_bytes = limits
            .memory_mb
            .checked_mul(1024 * 1024)
            .ok_or_else(|| SandboxError::PolicyViolation("memory limit overflows".into()))?;
        let quota = (limits.cpu * PERIOD_MICROS as f64).round() as u64;
        self.write("memory.max", &memory_bytes.to_string())?;
        self.write("memory.swap.max", "0")?;
        self.write("memory.oom.group", "1")?;
        self.write("pids.max", &limits.pids.to_string())?;
        self.write("cpu.max", &format!("{quota} {PERIOD_MICROS}"))?;
        Ok(())
    }

    fn write(&self, name: &str, value: &str) -> Result<(), SandboxError> {
        fs::write(self.path.join(name), format!("{value}\n")).map_err(SandboxError::Io)
    }
}

impl Drop for Cgroup {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

fn validate_job_id(job_id: &str) -> Result<(), SandboxError> {
    if job_id.is_empty()
        || job_id.len() > 64
        || !job_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(SandboxError::PolicyViolation(
            "invalid cgroup job ID".into(),
        ));
    }
    Ok(())
}

fn validate_limits(limits: ResourceLimits) -> Result<(), SandboxError> {
    if limits.memory_mb == 0 || limits.pids == 0 || !limits.cpu.is_finite() || limits.cpu <= 0.0 {
        return Err(SandboxError::PolicyViolation(
            "cgroup limits must be positive and finite".into(),
        ));
    }
    Ok(())
}

fn verify_cgroup2(root: &Path) -> Result<(), SandboxError> {
    let path = std::ffi::CString::new(root.as_os_str().as_encoded_bytes())
        .map_err(|_| SandboxError::PolicyViolation("cgroup path contains NUL".into()))?;
    let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `path` is a valid NUL-terminated path and `stats` points to writable memory.
    let result = unsafe { libc::statfs(path.as_ptr(), stats.as_mut_ptr()) };
    if result == -1 {
        return Err(SandboxError::Io(io::Error::last_os_error()));
    }
    // SAFETY: statfs initialized `stats` after returning success.
    let stats = unsafe { stats.assume_init() };
    if stats.f_type != CGROUP2_SUPER_MAGIC {
        return Err(SandboxError::CgroupUnavailable(format!(
            "{} is not a cgroup v2 filesystem",
            root.display()
        )));
    }
    Ok(())
}
