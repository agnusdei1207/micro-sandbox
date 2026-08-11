#![cfg(target_os = "linux")]

use serde_json::Value;
use std::process::Command;

#[test]
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
}
