use crate::error::SandboxError;
use crate::linux::pidfd::PidFd;
use crate::linux::{os_error, pipe, read_byte, write_byte};
use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::time::Instant;

const CLONE_INTO_CGROUP: u64 = 0x0002_0000_0000;

#[repr(C)]
#[derive(Debug, Default)]
struct CloneArgs {
    flags: u64,
    pidfd: u64,
    child_tid: u64,
    parent_tid: u64,
    exit_signal: u64,
    stack: u64,
    stack_size: u64,
    tls: u64,
    set_tid: u64,
    set_tid_size: u64,
    cgroup: u64,
}

pub enum CloneOutcome {
    Parent(NamespaceParent),
    Child(NamespaceChild),
}

/// Parent-side handle for a cloned child that is waiting for its user mappings.
///
/// Dropping it kills and reaps the child through the owned [`RunningChild`];
/// a successful [`NamespaceParent::map_current_user_and_release`] moves the child out,
/// which disarms that cleanup.
pub struct NamespaceParent {
    child: RunningChild,
    release_fd: OwnedFd,
    armed_fd: OwnedFd,
}

pub struct NamespaceChild {
    ready_fd: OwnedFd,
}

pub fn clone_isolated(cgroup_fd: Option<RawFd>) -> Result<CloneOutcome, SandboxError> {
    let (ready_fd, release_fd) = pipe()?;
    let (armed_fd, armed_write_fd) = pipe()?;

    let mut pidfd = -1_i32;
    let mut args = CloneArgs {
        flags: (libc::CLONE_NEWUSER
            | libc::CLONE_NEWPID
            | libc::CLONE_NEWNS
            | libc::CLONE_NEWNET
            | libc::CLONE_NEWIPC
            | libc::CLONE_NEWUTS
            | libc::CLONE_NEWCGROUP
            | libc::CLONE_PIDFD) as u64,
        pidfd: (&mut pidfd as *mut i32) as u64,
        exit_signal: libc::SIGCHLD as u64,
        ..CloneArgs::default()
    };
    if let Some(cgroup_fd) = cgroup_fd {
        args.flags |= CLONE_INTO_CGROUP;
        args.cgroup = cgroup_fd as u64;
    }

    // SAFETY: clone3 receives a correctly sized initialized clone_args. No shared-memory flags
    // are used, so parent and child receive independent address spaces like fork().
    let result = unsafe {
        libc::syscall(
            libc::SYS_clone3,
            &args as *const CloneArgs,
            std::mem::size_of::<CloneArgs>(),
        )
    };
    if result == -1 {
        return Err(os_error("clone3"));
    }
    if result == 0 {
        // Child: never return an error from here. Unwinding through the caller would run
        // copies of the parent's guards (cgroup kill, staging removal) inside the child.
        drop(release_fd);
        drop(armed_fd);
        // SAFETY: PR_SET_PDEATHSIG configures a signal for this child if its launcher dies.
        if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } == -1 {
            abort_child(b"ISOLATION_UNAVAILABLE: PR_SET_PDEATHSIG failed\n");
        }
        if write_byte(armed_write_fd.as_raw_fd(), 1).is_err() {
            abort_child(b"ISOLATION_UNAVAILABLE: launcher exited during parent-death setup\n");
        }
        drop(armed_write_fd);
        return Ok(CloneOutcome::Child(NamespaceChild { ready_fd }));
    }

    drop(ready_fd);
    drop(armed_write_fd);
    // SAFETY: CLONE_PIDFD initialized pidfd with a new descriptor owned by this parent.
    let pidfd = PidFd::from_owned(unsafe { OwnedFd::from_raw_fd(pidfd) });
    Ok(CloneOutcome::Parent(NamespaceParent {
        child: RunningChild {
            pid: result as i32,
            pidfd,
            reaped: false,
        },
        release_fd,
        armed_fd,
    }))
}

/// Terminates a freshly cloned child without unwinding or running exit handlers.
fn abort_child(message: &[u8]) -> ! {
    // SAFETY: write and _exit are async-signal-safe; message is a readable byte slice.
    unsafe {
        libc::write(libc::STDERR_FILENO, message.as_ptr().cast(), message.len());
        libc::_exit(127)
    }
}

impl NamespaceParent {
    pub fn map_current_user_and_release(
        self,
        deadline: Instant,
    ) -> Result<RunningChild, SandboxError> {
        // Any early return drops `self.child`, which kills and reaps the cloned child.
        wait_until_ready(self.armed_fd.as_raw_fd(), self.child.pidfd(), deadline)?;
        // SAFETY: getuid and getgid have no preconditions.
        let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
        let proc_dir = format!("/proc/{}", self.child.pid);
        match fs::write(format!("{proc_dir}/setgroups"), "deny\n") {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(SandboxError::Io(error)),
        }
        fs::write(format!("{proc_dir}/uid_map"), format!("0 {uid} 1\n"))?;
        fs::write(format!("{proc_dir}/gid_map"), format!("0 {gid} 1\n"))?;
        write_byte(self.release_fd.as_raw_fd(), 1)?;
        Ok(self.child)
    }
}

impl NamespaceChild {
    pub fn wait_for_mapping(self) -> Result<(), SandboxError> {
        match read_byte(self.ready_fd.as_raw_fd()) {
            Ok(Some(1)) => Ok(()),
            _ => Err(SandboxError::Security(
                "parent did not complete UID/GID mappings".into(),
            )),
        }
    }
}

/// A direct child process that is killed and reaped when dropped unless already reaped.
pub struct RunningChild {
    pid: i32,
    pidfd: PidFd,
    reaped: bool,
}

impl RunningChild {
    pub fn send_signal(&self, signal: i32) -> Result<(), SandboxError> {
        self.pidfd.send_signal(signal)
    }

    pub fn try_wait(&mut self) -> Result<Option<libc::c_int>, SandboxError> {
        let mut status = 0;
        // SAFETY: status points to writable memory and pid names our direct child.
        let result = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
        if result == self.pid {
            self.reaped = true;
            return Ok(Some(status));
        }
        if result == 0 {
            return Ok(None);
        }
        let error = io::Error::last_os_error();
        if error.kind() == io::ErrorKind::Interrupted {
            return Ok(None);
        }
        Err(SandboxError::Io(error))
    }

    pub fn wait(mut self) -> Result<libc::c_int, SandboxError> {
        let mut status = 0;
        loop {
            // SAFETY: status points to writable memory and pid names our direct child.
            let result = unsafe { libc::waitpid(self.pid, &mut status, 0) };
            if result == self.pid {
                self.reaped = true;
                return Ok(status);
            }
            let error = io::Error::last_os_error();
            if result == -1 && error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(SandboxError::Io(error));
        }
    }

    pub fn pidfd(&self) -> RawFd {
        self.pidfd.as_raw_fd()
    }
}

impl Drop for RunningChild {
    fn drop(&mut self) {
        if self.reaped {
            return;
        }
        let _ = self.send_signal(libc::SIGKILL);
        reap(self.pid);
        self.reaped = true;
    }
}

fn reap(pid: i32) {
    loop {
        // SAFETY: pid names our direct child; status is intentionally discarded.
        let result = unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
        if result == pid {
            return;
        }
        let error = io::Error::last_os_error();
        if result == -1 && error.kind() != io::ErrorKind::Interrupted {
            // ECHILD (already reaped) and unexpected errors both end the attempt.
            return;
        }
    }
}

pub(crate) fn wait_until_ready(
    fd: RawFd,
    pidfd: RawFd,
    deadline: Instant,
) -> Result<(), SandboxError> {
    let mut descriptors = [
        libc::pollfd {
            fd,
            events: libc::POLLIN | libc::POLLHUP,
            revents: 0,
        },
        libc::pollfd {
            fd: pidfd,
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(SandboxError::Security(
                "isolated child setup timed out".into(),
            ));
        }
        let timeout = i32::try_from(remaining.as_millis().max(1)).unwrap_or(i32::MAX);
        // SAFETY: descriptors points to two initialized pollfd values.
        let result =
            unsafe { libc::poll(descriptors.as_mut_ptr(), descriptors.len() as _, timeout) };
        if result == -1 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(SandboxError::Io(error));
        }
        if result == 0 {
            continue;
        }
        if descriptors[0].revents & libc::POLLIN != 0 && matches!(read_byte(fd), Ok(Some(1))) {
            return Ok(());
        }
        return Err(SandboxError::Security(
            "isolated child failed before completing security setup".into(),
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;
    use std::process::Command;
    use std::time::Duration;

    fn running_sleep() -> (std::process::Child, RunningChild) {
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id() as i32;
        let running = RunningChild {
            pid,
            pidfd: PidFd::open(pid).unwrap(),
            reaped: false,
        };
        (child, running)
    }

    #[test]
    fn mapping_handshake_obeys_deadline_when_child_never_arms() {
        let (mut child, running) = running_sleep();
        let (armed, stalled_writer) = UnixStream::pair().unwrap();
        let (release, _reader) = UnixStream::pair().unwrap();
        let parent = NamespaceParent {
            child: running,
            release_fd: release.into(),
            armed_fd: armed.into(),
        };
        // Bound the regression itself: the old blocking read wakes after one second.
        let watchdog = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(1));
            drop(stalled_writer);
        });
        let started = Instant::now();
        let result = parent.map_current_user_and_release(started + Duration::from_millis(20));
        // The namespace guard already reaps on failure; consume the std handle too.
        let _ = child.wait();
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "mapping exceeded its setup deadline"
        );
        watchdog.join().unwrap();
    }

    #[test]
    fn dropping_an_unreleased_namespace_parent_kills_and_reaps_the_child() {
        let (mut child, running) = running_sleep();
        let pid = running.pid;
        let (armed, _armed_writer) = UnixStream::pair().unwrap();
        let (release, _reader) = UnixStream::pair().unwrap();
        drop(NamespaceParent {
            child: running,
            release_fd: release.into(),
            armed_fd: armed.into(),
        });
        // The guard reaped the child, so it no longer exists as our child.
        // SAFETY: waitpid with WNOHANG on a PID we spawned; status may be null.
        let result = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
        assert_eq!(result, -1);
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
        let _ = child.wait();
    }
}
