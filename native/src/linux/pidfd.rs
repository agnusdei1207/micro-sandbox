use crate::error::SandboxError;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

#[derive(Debug)]
pub struct PidFd(OwnedFd);

impl PidFd {
    pub fn open(pid: i32) -> Result<Self, SandboxError> {
        if pid <= 0 {
            return Err(SandboxError::PolicyViolation("PID must be positive".into()));
        }
        // SAFETY: pidfd_open does not dereference user pointers; flags 0 is the documented API.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as i32;
        if fd == -1 {
            return Err(SandboxError::Io(io::Error::last_os_error()));
        }
        // SAFETY: a successful pidfd_open returns a new owned file descriptor.
        Ok(Self(unsafe { OwnedFd::from_raw_fd(fd) }))
    }

    /// Wraps a descriptor that the kernel returned as a pidfd, e.g. from `CLONE_PIDFD`.
    pub(crate) const fn from_owned(fd: OwnedFd) -> Self {
        Self(fd)
    }

    pub fn send_signal(&self, signal: i32) -> Result<(), SandboxError> {
        // SAFETY: the pidfd is owned and valid; null siginfo and flags 0 are documented.
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                self.0.as_raw_fd(),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result == -1 {
            let error = io::Error::last_os_error();
            // The waiter may reap a completed launcher before cancellation is drained.
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(SandboxError::Io(error));
            }
        }
        Ok(())
    }
}

impl AsRawFd for PidFd {
    fn as_raw_fd(&self) -> RawFd {
        self.0.as_raw_fd()
    }
}
