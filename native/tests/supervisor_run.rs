#![cfg(target_os = "linux")]

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn supervisor_executes_a_correlated_job_request() {
    if !privileged() {
        return;
    }
    let mut supervisor = start_supervisor();
    send(
        &mut supervisor,
        json!({
            "version": 1,
            "id": 41,
            "type": "run",
            "payload": spec("supervisor-run", "printf connected", 2_000)
        }),
    );
    let response = receive(&mut supervisor);
    assert_eq!(response["id"], 41);
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(decode(&response["result"]["stdoutBase64"]), b"connected");
    stop_supervisor(supervisor);
}

#[test]
fn supervisor_cancels_a_running_process_tree() {
    if !privileged() {
        return;
    }
    let cgroup_root = std::env::var("MICRO_SANDBOX_CGROUP_ROOT").unwrap();
    let mut supervisor = start_supervisor();
    send(
        &mut supervisor,
        json!({
            "version": 1,
            "id": 51,
            "type": "run",
            "payload": spec("supervisor-cancel", "trap '' TERM; sleep 30", 30_000)
        }),
    );
    wait_for_path(&std::path::Path::new(&cgroup_root).join("supervisor-cancel"));
    send(
        &mut supervisor,
        json!({
            "version": 1,
            "id": 51,
            "type": "cancel",
            "payload": { "requestId": 51 }
        }),
    );
    let response = receive(&mut supervisor);
    assert_eq!(response["id"], 51);
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "CANCELLED");
    assert!(
        !std::path::Path::new(&cgroup_root)
            .join("supervisor-cancel")
            .exists()
    );
    stop_supervisor(supervisor);
}

fn start_supervisor() -> Child {
    Command::new(env!("CARGO_BIN_EXE_micro-sandbox"))
        .arg("supervise")
        .env(
            "MICRO_SANDBOX_CGROUP_ROOT",
            std::env::var("MICRO_SANDBOX_CGROUP_ROOT").unwrap(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn send(child: &mut Child, value: Value) {
    writeln!(child.stdin.as_mut().unwrap(), "{value}").unwrap();
    child.stdin.as_mut().unwrap().flush().unwrap();
}

fn receive(child: &mut Child) -> Value {
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().unwrap())
        .read_line(&mut line)
        .unwrap();
    serde_json::from_str(&line).unwrap()
}

fn stop_supervisor(mut child: Child) {
    send(
        &mut child,
        json!({ "version": 1, "id": 999, "type": "shutdown", "payload": {} }),
    );
    assert!(child.wait().unwrap().success());
}

fn spec(job_id: &str, script: &str, timeout_ms: u64) -> Value {
    json!({
        "jobId": job_id,
        "rootfs": "/",
        "command": "/bin/sh",
        "args": ["-c", script],
        "limits": {
            "timeoutMs": timeout_ms,
            "memoryMb": 64,
            "cpu": 0.5,
            "pids": 8,
            "inputBytes": 1024,
            "outputBytes": 1024
        }
    })
}

fn wait_for_path(path: &std::path::Path) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while !path.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(2));
    }
    assert!(path.exists(), "{} was not created", path.display());
}

fn decode(value: &Value) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(value.as_str().unwrap())
        .unwrap()
}

fn privileged() -> bool {
    std::env::var_os("MICRO_SANDBOX_PRIVILEGED_TESTS").is_some()
}
