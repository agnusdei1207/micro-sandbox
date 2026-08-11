#![cfg(target_os = "linux")]

use serde_json::Value;
use std::process::Command;

#[test]
fn creates_all_required_namespaces_and_disconnects_network() {
    if std::env::var_os("MICRO_SANDBOX_PRIVILEGED_TESTS").is_none() {
        return;
    }
    let output = Command::new(env!("CARGO_BIN_EXE_micro-sandbox"))
        .arg("namespace-probe")
        .output()
        .expect("run namespace probe");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["pidInside"], 1);
    assert_eq!(report["networkDisconnected"], true);
    for namespace in ["user", "pid", "mnt", "net", "ipc", "uts", "cgroup"] {
        assert_eq!(report["changed"][namespace], true, "{namespace}");
    }
}
