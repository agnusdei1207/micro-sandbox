use crate::config::{CPU_PERIOD_MICROS, ResourceLimits};
use crate::error::SandboxError;
use crate::linux::paths::path_cstring;
use std::fs;
use std::io;
use std::os::fd::{FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const CGROUP2_SUPER_MAGIC: libc::c_long = 0x6367_7270;
const REMOVE_TIMEOUT: Duration = Duration::from_secs(1);

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

    pub fn open_fd(&self) -> Result<OwnedFd, SandboxError> {
        let path = path_cstring(&self.path)?;
        // SAFETY: path is NUL-terminated and flags request a new directory descriptor.
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd == -1 {
            return Err(SandboxError::Io(io::Error::last_os_error()));
        }
        // SAFETY: open returned a new owned descriptor.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    pub fn kill_all(&self) -> Result<(), SandboxError> {
        self.write("cgroup.kill", "1")
    }

    pub fn memory_peak_bytes(&self) -> Option<u64> {
        read_u64(&self.path.join("memory.peak"))
    }

    pub fn memory_current_bytes(&self) -> Option<u64> {
        read_u64(&self.path.join("memory.current"))
    }

    pub fn oom_killed(&self) -> bool {
        fs::read_to_string(self.path.join("memory.events"))
            .ok()
            .and_then(|events| {
                events.lines().find_map(|line| {
                    let mut fields = line.split_whitespace();
                    (fields.next()? == "oom_kill")
                        .then(|| fields.next()?.parse::<u64>().ok())
                        .flatten()
                })
            })
            .is_some_and(|count| count > 0)
    }

    pub fn cleanup(&mut self) -> Result<(), SandboxError> {
        if self.cleaned {
            return Ok(());
        }
        if !self.path.exists() {
            self.cleaned = true;
            return Ok(());
        }

        let kill_result = self.kill_all();
        if self.mode == CgroupMode::Emulated {
            for entry in fs::read_dir(&self.path)? {
                let path = entry?.path();
                if path.is_file() {
                    fs::remove_file(path)?;
                }
            }
        }
        remove_dir(&self.path, self.mode == CgroupMode::Kernel)?;
        self.cleaned = true;
        kill_result
    }

    fn configure(&self, limits: ResourceLimits) -> Result<(), SandboxError> {
        let memory_bytes = limits
            .memory_mb
            .checked_mul(1024 * 1024)
            .ok_or_else(|| SandboxError::PolicyViolation("memory limit overflows".into()))?;
        let quota = limits
            .cpu_quota_micros()
            .map_err(|message| SandboxError::PolicyViolation(message.into()))?;
        self.write("memory.max", &memory_bytes.to_string())?;
        self.write("memory.swap.max", "0")?;
        self.write("memory.oom.group", "1")?;
        self.write("pids.max", &limits.pids.to_string())?;
        self.write("cpu.max", &format!("{quota} {CPU_PERIOD_MICROS}"))?;
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

/// Kills every process in a job cgroup below `root` and removes the directory.
///
/// A missing directory is treated as already removed, so callers can retry safely.
pub fn remove_job_dir(root: &Path, job_id: &str) -> Result<(), SandboxError> {
    validate_job_id(job_id)?;
    let path = root.join(job_id);
    if !path.exists() {
        return Ok(());
    }
    // Best effort: an already-empty or concurrently removed cgroup needs no kill.
    let _ = fs::write(path.join("cgroup.kill"), "1\n");
    remove_dir(&path, true)
}

/// Removes a cgroup directory, optionally waiting briefly for killed tasks to exit.
fn remove_dir(path: &Path, retry_busy: bool) -> Result<(), SandboxError> {
    let deadline = Instant::now() + REMOVE_TIMEOUT;
    loop {
        match fs::remove_dir(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error)
                if retry_busy
                    && error.raw_os_error() == Some(libc::EBUSY)
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(SandboxError::Io(error)),
        }
    }
}

/// Reads the delegated cgroup root shared by the supervisor and its launchers.
pub fn root_from_env() -> Result<PathBuf, SandboxError> {
    std::env::var_os("MICRO_SANDBOX_CGROUP_ROOT")
        .map(PathBuf::from)
        .ok_or_else(|| {
            SandboxError::CgroupUnavailable("MICRO_SANDBOX_CGROUP_ROOT is not set".into())
        })
}

pub fn validate_job_id(job_id: &str) -> Result<(), SandboxError> {
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

pub(crate) fn read_u64(path: &Path) -> Option<u64> {
    fs::read_to_string(path)
        .ok()
        .and_then(|value| value.trim().parse().ok())
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
    let path = path_cstring(root)?;
    let mut stats = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: `path` is a valid NUL-terminated path and `stats` points to writable memory.
    let result = unsafe { libc::statfs(path.as_ptr(), stats.as_mut_ptr()) };
    if result == -1 {
        return Err(SandboxError::Io(io::Error::last_os_error()));
    }
    // SAFETY: statfs initialized `stats` after returning success.
    let stats = unsafe { stats.assume_init() };
    if stats.f_type as u64 != CGROUP2_SUPER_MAGIC as u64 {
        return Err(SandboxError::CgroupUnavailable(format!(
            "{} is not a cgroup v2 filesystem",
            root.display()
        )));
    }
    Ok(())
}
