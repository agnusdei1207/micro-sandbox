#![cfg(target_os = "linux")]

use serde_json::Value;
use std::process::Command;

#[test]
fn guest_cannot_change_its_parent_death_signal() {
    // Filters apply to the calling thread; keep the test harness unrestricted.
    std::thread::spawn(|| {
        // SAFETY: both prctl operations accept the supplied scalar arguments.
        assert_eq!(
            unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) },
            0
        );
        micro_sandbox_native::linux::seccomp::apply_baseline().unwrap();
        for signal in [0, libc::SIGTERM] {
            // SAFETY: PR_SET_PDEATHSIG accepts a signal number or zero.
            assert_eq!(
                unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, signal, 0, 0, 0) },
                -1
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::EPERM)
            );
        }
        let mut signal = 0;
        // SAFETY: signal points to a writable integer for PR_GET_PDEATHSIG.
        assert_eq!(
            unsafe { libc::prctl(libc::PR_GET_PDEATHSIG, &mut signal, 0, 0, 0) },
            0
        );
        assert_eq!(signal, libc::SIGKILL);
    })
    .join()
    .unwrap();
}

#[test]
#[ignore = "requires the privileged Linux kernel test runner"]
fn security_probe_drops_privilege_and_blocks_dangerous_syscalls() {
    let output = Command::new(env!("CARGO_BIN_EXE_micro-sandbox"))
        .arg("security-probe")
        .output()
        .expect("run security probe");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["noNewPrivileges"], true);
    for field in [
        "effectiveCapabilities",
        "permittedCapabilities",
        "inheritableCapabilities",
        "boundingCapabilities",
        "ambientCapabilities",
    ] {
        assert_eq!(report[field], 0, "{field}");
    }
    assert_eq!(report["ptraceBlocked"], true);
    assert_eq!(report["mountBlocked"], true);
    assert_eq!(report["newMountApiBlocked"], true);
    assert_eq!(report["namespaceCreationBlocked"], true);
    assert_eq!(report["fallocateBlocked"], true);
    assert_eq!(report["ioUringBlocked"], true);
    assert_eq!(report["preallocationIoctlBlocked"], true);
}
