use micro_sandbox_native::error::SandboxError;
use micro_sandbox_native::protocol::MAX_FRAME_BYTES;
use serde_json::json;
use std::io::{self, Read};

fn main() {
    let result = match std::env::args().nth(1).as_deref() {
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
        eprintln!("{}: {error}", error.code());
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
fn launch() -> Result<(), SandboxError> {
    use micro_sandbox_native::job::{LaunchSpec, launch};
    use std::path::PathBuf;

    let mut input = Vec::new();
    io::stdin()
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_to_end(&mut input)?;
    if input.len() > MAX_FRAME_BYTES {
        return Err(SandboxError::Protocol("launch spec exceeds 1 MiB".into()));
    }
    let spec: LaunchSpec = serde_json::from_slice(&input)?;
    let cgroup_root = std::env::var_os("MICRO_SANDBOX_CGROUP_ROOT")
        .map(PathBuf::from)
        .ok_or_else(|| {
            SandboxError::CgroupUnavailable("MICRO_SANDBOX_CGROUP_ROOT is not set".into())
        })?;
    let result = launch(spec, &cgroup_root)?;
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
            let child = parent.map_current_user_and_release()?;
            let status = child.wait()?;
            if !libc::WIFEXITED(status) || libc::WEXITSTATUS(status) != 0 {
                return Err(SandboxError::Security(format!(
                    "namespace probe child failed with status {status}"
                )));
            }
        }
        CloneOutcome::Child(child) => {
            if let Err(error) = child.wait_for_mapping().and_then(|()| {
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
                        "pidInside": unsafe { libc::getpid() },
                        "networkDisconnected": network_disconnected,
                        "changed": changed,
                    })
                );
                Ok(())
            }) {
                eprintln!("{}: {error}", error.code());
                // SAFETY: _exit terminates only the isolated child without running copied guards.
                unsafe { libc::_exit(1) };
            }
            // SAFETY: _exit avoids unwinding copied parent state after clone3.
            unsafe { libc::_exit(0) };
        }
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn network_is_disconnected() -> Result<bool, SandboxError> {
    use std::io;

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
    use micro_sandbox_native::linux::{capabilities, seccomp};

    seccomp::apply_baseline()?;
    capabilities::drop_all()?;
    let masks = capabilities::capability_masks()?;
    // SAFETY: both calls intentionally use invalid/null arguments; seccomp must reject them first.
    let ptrace = unsafe { libc::syscall(libc::SYS_ptrace, libc::PTRACE_ATTACH, 1, 0, 0) };
    let ptrace_blocked =
        ptrace == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    // SAFETY: null pointers are never dereferenced because seccomp rejects SYS_mount.
    let mount = unsafe {
        libc::syscall(
            libc::SYS_mount,
            std::ptr::null::<libc::c_char>(),
            std::ptr::null::<libc::c_char>(),
            std::ptr::null::<libc::c_char>(),
            0,
            std::ptr::null::<libc::c_void>(),
        )
    };
    let mount_blocked =
        mount == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);

    println!(
        "{}",
        json!({
            "noNewPrivileges": true,
            "effectiveCapabilities": masks.effective,
            "permittedCapabilities": masks.permitted,
            "inheritableCapabilities": masks.inheritable,
            "boundingCapabilities": masks.bounding,
            "ambientCapabilities": masks.ambient,
            "ptraceBlocked": ptrace_blocked,
            "mountBlocked": mount_blocked,
        })
    );
    Ok(())
}
