use micro_sandbox_native::error::{ErrorBody, SandboxError};
use micro_sandbox_native::protocol::MAX_FRAME_BYTES;
use serde_json::json;
use std::io::{self, Read};

fn main() {
    let mode = std::env::args().nth(1);
    let result = match mode.as_deref() {
        #[cfg(target_os = "linux")]
        Some("supervise") => micro_sandbox_native::supervisor::supervise(),
        #[cfg(target_os = "linux")]
        Some("security-probe") => security_probe(),
        #[cfg(target_os = "linux")]
        Some("namespace-probe") => namespace_probe(),
        #[cfg(target_os = "linux")]
        Some("launch") => launch(),
        Some("--version" | "-V") => {
            println!("micro-sandbox {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => Err(SandboxError::Protocol(
            "expected `supervise`, `launch`, or `--version`".into(),
        )),
    };
    if let Err(error) = result {
        if mode.as_deref() == Some("launch") {
            // The supervisor parses this line to relay the original error code.
            eprintln!("{}", json!({ "error": ErrorBody::from(&error) }));
        } else {
            eprintln!("{}: {error}", error.code());
        }
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
fn launch() -> Result<(), SandboxError> {
    use micro_sandbox_native::job::{LaunchSpec, launch};
    use micro_sandbox_native::linux::cgroup;

    let mut input = Vec::new();
    io::stdin()
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut input)?;
    if input.len() > MAX_FRAME_BYTES {
        return Err(SandboxError::Protocol("launch spec exceeds 1 MiB".into()));
    }
    let spec: LaunchSpec = serde_json::from_slice(&input)
        .map_err(|error| SandboxError::Protocol(format!("invalid launch spec: {error}")))?;
    let result = launch(spec, &cgroup::root_from_env()?)?;
    serde_json::to_writer(io::stdout().lock(), &result)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn namespace_probe() -> Result<(), SandboxError> {
    use micro_sandbox_native::linux::clone::{CloneOutcome, clone_isolated};
    use std::collections::BTreeMap;

    let namespace_names = ["user", "pid", "mnt", "net", "ipc", "uts", "cgroup"];
    let before: BTreeMap<_, _> = namespace_names
        .iter()
        .map(|name| {
            std::fs::read_link(format!("/proc/self/ns/{name}"))
                .map(|value| ((*name).to_string(), value))
        })
        .collect::<Result<_, _>>()?;

    match clone_isolated(None)? {
        CloneOutcome::Parent(parent) => {
            let child = parent.map_current_user_and_release(
                std::time::Instant::now() + std::time::Duration::from_secs(5),
            )?;
            let status = child.wait()?;
            if !libc::WIFEXITED(status) || libc::WEXITSTATUS(status) != 0 {
                return Err(SandboxError::Security(format!(
                    "namespace probe child failed with status {status}"
                )));
            }
        }
        CloneOutcome::Child(child) => {
            // Never unwind out of the child: that would run copies of the parent's state.
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                child.wait_for_mapping()?;
                let changed: BTreeMap<_, _> = namespace_names
                    .iter()
                    .map(|name| {
                        std::fs::read_link(format!("/proc/self/ns/{name}"))
                            .map(|value| ((*name).to_string(), value != before[*name]))
                    })
                    .collect::<Result<_, _>>()?;
                let network_disconnected = network_is_disconnected()?;
                println!(
                    "{}",
                    json!({
                        // SAFETY: getpid has no preconditions.
                        "pidInside": unsafe { libc::getpid() },
                        "networkDisconnected": network_disconnected,
                        "changed": changed,
                    })
                );
                Ok::<(), SandboxError>(())
            }))
            .unwrap_or_else(|_| Err(SandboxError::Security("namespace probe panicked".into())));
            let code = match outcome {
                Ok(()) => 0,
                Err(error) => {
                    eprintln!("{}: {error}", error.code());
                    1
                }
            };
            // SAFETY: _exit terminates only the isolated child without running copied guards.
            unsafe { libc::_exit(code) };
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn network_is_disconnected() -> Result<bool, SandboxError> {
    // SAFETY: socket arguments are valid and return a new descriptor on success.
    let socket = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    if socket == -1 {
        return Err(SandboxError::Io(io::Error::last_os_error()));
    }
    let address = libc::sockaddr_in {
        sin_family: libc::AF_INET as u16,
        sin_port: 53_u16.to_be(),
        sin_addr: libc::in_addr {
            s_addr: u32::from_ne_bytes([1, 1, 1, 1]),
        },
        sin_zero: [0; 8],
    };
    // SAFETY: address is a valid initialized IPv4 sockaddr.
    let result = unsafe {
        libc::connect(
            socket,
            (&address as *const libc::sockaddr_in).cast(),
            std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
        )
    };
    let error = io::Error::last_os_error();
    // SAFETY: socket is owned by this function.
    unsafe { libc::close(socket) };
    Ok(result == -1
        && matches!(
            error.raw_os_error(),
            Some(libc::ENETUNREACH) | Some(libc::ENETDOWN) | Some(libc::EHOSTUNREACH)
        ))
}

#[cfg(target_os = "linux")]
fn security_probe() -> Result<(), SandboxError> {
    use micro_sandbox_native::linux::{self, capabilities, seccomp};
    use std::collections::BTreeMap;

    fn returns(result: libc::c_long, errno: i32) -> bool {
        result == -1 && io::Error::last_os_error().raw_os_error() == Some(errno)
    }

    // Use the production hardening sequence so the probe observes the same state as a guest.
    linux::harden(None)?;
    let masks = capabilities::capability_masks()?;
    // SAFETY: all calls below intentionally use invalid/null arguments; seccomp must
    // reject them before the kernel inspects those arguments.
    let (ptrace, mount, fsopen, clone3, fallocate, io_uring) = unsafe {
        (
            returns(
                libc::syscall(libc::SYS_ptrace, libc::PTRACE_ATTACH, 1, 0, 0),
                libc::EPERM,
            ),
            returns(
                libc::syscall(
                    libc::SYS_mount,
                    std::ptr::null::<libc::c_char>(),
                    std::ptr::null::<libc::c_char>(),
                    std::ptr::null::<libc::c_char>(),
                    0,
                    std::ptr::null::<libc::c_void>(),
                ),
                libc::EPERM,
            ),
            returns(
                libc::syscall(libc::SYS_fsopen, std::ptr::null::<libc::c_char>(), 0),
                libc::EPERM,
            ),
            returns(
                libc::syscall(libc::SYS_clone3, std::ptr::null::<libc::c_void>(), 0),
                libc::ENOSYS,
            ),
            returns(
                libc::syscall(libc::SYS_fallocate, -1, 1, 0, 1024),
                libc::EPERM,
            ),
            returns(
                libc::syscall(
                    libc::SYS_io_uring_setup,
                    1,
                    std::ptr::null::<libc::c_void>(),
                ),
                libc::EPERM,
            ),
        )
    };
    let probes: BTreeMap<_, _> = seccomp::probe_baseline().into_iter().collect();
    let preallocation_ioctl_blocked = probes["ioctl_resvsp"];

    println!(
        "{}",
        json!({
            "noNewPrivileges": true,
            "effectiveCapabilities": masks.effective,
            "permittedCapabilities": masks.permitted,
            "inheritableCapabilities": masks.inheritable,
            "boundingCapabilities": masks.bounding,
            "ambientCapabilities": masks.ambient,
            "ptraceBlocked": ptrace,
            "mountBlocked": mount,
            "newMountApiBlocked": fsopen,
            "namespaceCreationBlocked": clone3,
            "fallocateBlocked": fallocate,
            "ioUringBlocked": io_uring,
            "preallocationIoctlBlocked": preallocation_ioctl_blocked,
            "syscallProbes": probes,
        })
    );
    Ok(())
}
