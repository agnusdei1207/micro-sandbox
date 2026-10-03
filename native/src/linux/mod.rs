pub mod capabilities;
pub mod cgroup;
pub mod clone;
pub mod mount;
pub mod paths;
pub mod pidfd;
pub mod seccomp;

use crate::error::SandboxError;
use std::io;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};

/// Converts the current `errno` into a security error.
///
/// Call this immediately after the failing syscall with a static operation name;
/// any allocation between the syscall and this call may clobber `errno`.
pub(crate) fn os_error(operation: &str) -> SandboxError {
    let error = io::Error::last_os_error();
    SandboxError::Security(format!("{operation}: {error}"))
}

/// Creates a close-on-exec pipe and returns its `(read, write)` ends.
pub fn pipe() -> Result<(OwnedFd, OwnedFd), SandboxError> {
    let mut descriptors = [-1; 2];
    // SAFETY: descriptors points to two writable integers; O_CLOEXEC is a valid flag.
    if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } == -1 {
        return Err(SandboxError::Io(io::Error::last_os_error()));
    }
    // SAFETY: pipe2 returned two new descriptors that nothing else owns.
    Ok(unsafe {
        (
            OwnedFd::from_raw_fd(descriptors[0]),
            OwnedFd::from_raw_fd(descriptors[1]),
        )
    })
}

/// Writes one handshake byte, retrying when interrupted by a signal.
pub(crate) fn write_byte(fd: RawFd, value: u8) -> io::Result<()> {
    let byte = [value];
    loop {
        // SAFETY: fd is a caller-owned descriptor and byte points to one readable byte.
        match unsafe { libc::write(fd, byte.as_ptr().cast(), 1) } {
            1 => return Ok(()),
            -1 => {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
            _ => return Err(io::Error::from(io::ErrorKind::WriteZero)),
        }
    }
}

/// Reads one handshake byte, retrying when interrupted. `None` means end of file.
pub(crate) fn read_byte(fd: RawFd) -> io::Result<Option<u8>> {
    let mut byte = [0_u8];
    loop {
        // SAFETY: fd is a caller-owned descriptor and byte points to one writable byte.
        match unsafe { libc::read(fd, byte.as_mut_ptr().cast(), 1) } {
            1 => return Ok(Some(byte[0])),
            0 => return Ok(None),
            _ => {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
        }
    }
}

/// Applies the final process restrictions in the order used for every guest:
/// optional file-size limit, zero capabilities, no core dumps, then seccomp.
///
/// The security probe calls this same function so it observes production behavior.
pub fn harden(file_size_limit: Option<u64>) -> Result<(), SandboxError> {
    if let Some(bytes) = file_size_limit {
        let limit = rlimit(bytes);
        // SAFETY: limit points to a valid rlimit value for the current process.
        if unsafe { libc::setrlimit(libc::RLIMIT_FSIZE, &limit) } == -1 {
            return Err(os_error("setrlimit RLIMIT_FSIZE"));
        }
    }
    capabilities::drop_all()?;
    let limit = rlimit(0);
    // SAFETY: limit points to a valid rlimit and RLIMIT_CORE is supported on Linux.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } == -1 {
        return Err(os_error("setrlimit RLIMIT_CORE"));
    }
    // SAFETY: PR_SET_DUMPABLE accepts a scalar zero with zero trailing arguments.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } == -1 {
        return Err(os_error("PR_SET_DUMPABLE"));
    }
    seccomp::apply_baseline()
}

const fn rlimit(bytes: u64) -> libc::rlimit {
    libc::rlimit {
        rlim_cur: bytes,
        rlim_max: bytes,
    }
}
