use crate::error::SandboxError;
use std::fs;
use std::io;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};

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

pub struct NamespaceParent {
    pid: i32,
    pidfd: OwnedFd,
    release_fd: OwnedFd,
}

pub struct NamespaceChild {
    ready_fd: OwnedFd,
}

pub fn clone_isolated(cgroup_fd: Option<RawFd>) -> Result<CloneOutcome, SandboxError> {
    let mut pipe_fds = [-1; 2];
    // SAFETY: pipe_fds points to two writable integers; O_CLOEXEC is a valid flag.
    if unsafe { libc::pipe2(pipe_fds.as_mut_ptr(), libc::O_CLOEXEC) } == -1 {
        return Err(SandboxError::Io(io::Error::last_os_error()));
    }
    // SAFETY: pipe2 returned two new owned descriptors.
    let ready_fd = unsafe { OwnedFd::from_raw_fd(pipe_fds[0]) };
    // SAFETY: pipe2 returned two new owned descriptors.
    let release_fd = unsafe { OwnedFd::from_raw_fd(pipe_fds[1]) };

    let mut pidfd = -1_i32;
    let mut flags = (libc::CLONE_NEWUSER
        | libc::CLONE_NEWPID
        | libc::CLONE_NEWNS
        | libc::CLONE_NEWNET
        | libc::CLONE_NEWIPC
        | libc::CLONE_NEWUTS
        | libc::CLONE_NEWCGROUP
        | libc::CLONE_PIDFD) as u64;
    let mut args = CloneArgs {
        flags,
        pidfd: (&mut pidfd as *mut i32) as u64,
        exit_signal: libc::SIGCHLD as u64,
        ..CloneArgs::default()
    };
    if let Some(cgroup_fd) = cgroup_fd {
        const CLONE_INTO_CGROUP: u64 = 0x0002_0000_0000;
        flags |= CLONE_INTO_CGROUP;
        args.flags = flags;
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
        return Err(SandboxError::Security(format!(
            "clone3: {}",
            io::Error::last_os_error()
        )));
    }
    if result == 0 {
        drop(release_fd);
        // SAFETY: PR_SET_PDEATHSIG configures a signal for this child if its launcher dies.
        if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) } == -1 {
            return Err(SandboxError::Security(format!(
                "PR_SET_PDEATHSIG: {}",
                io::Error::last_os_error()
            )));
        }
        return Ok(CloneOutcome::Child(NamespaceChild { ready_fd }));
    }

    drop(ready_fd);
    // SAFETY: CLONE_PIDFD initialized pidfd with a new descriptor in the parent.
    let pidfd = unsafe { OwnedFd::from_raw_fd(pidfd) };
    Ok(CloneOutcome::Parent(NamespaceParent {
        pid: result as i32,
        pidfd,
        release_fd,
    }))
}

impl NamespaceParent {
    pub fn pid(&self) -> i32 {
        self.pid
    }

    pub fn map_current_user_and_release(self) -> Result<RunningChild, SandboxError> {
        let uid = unsafe { libc::getuid() };
        let gid = unsafe { libc::getgid() };
        let proc_dir = format!("/proc/{}", self.pid);
        match fs::write(format!("{proc_dir}/setgroups"), "deny\n") {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(SandboxError::Io(error)),
        }
        fs::write(format!("{proc_dir}/uid_map"), format!("0 {uid} 1\n"))?;
        fs::write(format!("{proc_dir}/gid_map"), format!("0 {gid} 1\n"))?;
        let byte = [1_u8];
        // SAFETY: release_fd is valid and byte points to one readable byte.
        if unsafe { libc::write(raw_fd(&self.release_fd), byte.as_ptr().cast(), 1) } != 1 {
            return Err(SandboxError::Io(io::Error::last_os_error()));
        }
        Ok(RunningChild {
            pid: self.pid,
            pidfd: self.pidfd,
        })
    }
}

impl NamespaceChild {
    pub fn wait_for_mapping(self) -> Result<(), SandboxError> {
        let mut byte = [0_u8];
        // SAFETY: ready_fd is valid and byte points to one writable byte.
        let result = unsafe { libc::read(raw_fd(&self.ready_fd), byte.as_mut_ptr().cast(), 1) };
        if result != 1 || byte[0] != 1 {
            return Err(SandboxError::Security(
                "parent did not complete UID/GID mappings".into(),
            ));
        }
        Ok(())
    }
}

pub struct RunningChild {
    pid: i32,
    #[allow(dead_code)]
    pidfd: OwnedFd,
}

impl RunningChild {
    pub fn pid(&self) -> i32 {
        self.pid
    }

    pub fn send_signal(&self, signal: i32) -> Result<(), SandboxError> {
        // SAFETY: the pidfd is owned and valid; null siginfo and flags 0 are documented.
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                raw_fd(&self.pidfd),
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        if result == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(SandboxError::Io(error));
            }
        }
        Ok(())
    }

    pub fn try_wait(&self) -> Result<Option<libc::c_int>, SandboxError> {
        let mut status = 0;
        // SAFETY: status points to writable memory and pid names our direct child.
        let result = unsafe { libc::waitpid(self.pid, &mut status, libc::WNOHANG) };
        if result == self.pid {
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

    pub fn wait(self) -> Result<libc::c_int, SandboxError> {
        let mut status = 0;
        loop {
            // SAFETY: status points to writable memory and pid names our direct child.
            let result = unsafe { libc::waitpid(self.pid, &mut status, 0) };
            if result == self.pid {
                return Ok(status);
            }
            if result == -1 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(SandboxError::Io(io::Error::last_os_error()));
        }
    }
}

fn raw_fd(fd: &OwnedFd) -> RawFd {
    use std::os::fd::AsRawFd;
    fd.as_raw_fd()
}
