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
    let owned_job = wait_for_owned_job(std::path::Path::new(&cgroup_root), supervisor.id(), 51);
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
            .join(owned_job.file_name().unwrap())
            .exists()
    );
    stop_supervisor(supervisor);
}

#[test]
fn a_restarted_supervisor_reconciles_jobs_left_by_a_crash() {
    if !privileged() {
        return;
    }
    let cgroup_root = std::env::var("MICRO_SANDBOX_CGROUP_ROOT").unwrap();
    let mut supervisor = start_supervisor();
    send(
        &mut supervisor,
        json!({
            "version": 1,
            "id": 61,
            "type": "run",
            "payload": spec("supervisor-crash", "sleep 30", 30_000)
        }),
    );
    let stale = wait_for_owned_job(std::path::Path::new(&cgroup_root), supervisor.id(), 61);
    supervisor.kill().unwrap();
    supervisor.wait().unwrap();

    let mut restarted = start_supervisor();
    send(
        &mut restarted,
        json!({ "version": 1, "id": 62, "type": "health", "payload": {} }),
    );
    let response = receive(&mut restarted);
    assert_eq!(response["ok"], true, "{response}");
    assert!(!stale.exists());
    stop_supervisor(restarted);
}

#[test]
fn a_second_live_supervisor_does_not_reconcile_the_first_supervisors_jobs() {
    if !privileged() {
        return;
    }
    let root = std::env::var("MICRO_SANDBOX_CGROUP_ROOT").unwrap();
    let mut first = start_supervisor();
    send(
        &mut first,
        json!({
            "version": 1,
            "id": 81,
            "type": "run",
            "payload": spec("ignored", "sleep 30", 30_000)
        }),
    );
    let active = wait_for_owned_job(std::path::Path::new(&root), first.id(), 81);

    let mut second = start_supervisor();
    send(
        &mut second,
        json!({ "version": 1, "id": 82, "type": "health", "payload": {} }),
    );
    assert_eq!(receive(&mut second)["ok"], true);
    assert!(
        active.exists(),
        "second supervisor removed a live owner's job"
    );

    send(
        &mut first,
        json!({ "version": 1, "id": 83, "type": "cancel", "payload": { "requestId": 81 } }),
    );
    assert_eq!(receive(&mut first)["error"]["code"], "CANCELLED");
    stop_supervisor(second);
    stop_supervisor(first);
}

#[test]
fn supervisor_ignores_caller_job_ids_and_uses_an_owned_identifier() {
    if !privileged() {
        return;
    }
    let mut supervisor = start_supervisor();
    send(
        &mut supervisor,
        json!({
            "version": 1,
            "id": 71,
            "type": "run",
            "payload": spec("../outside", "true", 2_000)
        }),
    );
    let response = receive(&mut supervisor);
    assert_eq!(response["id"], 71);
    assert_eq!(response["ok"], true, "{response}");

    send(
        &mut supervisor,
        json!({ "version": 1, "id": 72, "type": "health", "payload": {} }),
    );
    assert_eq!(receive(&mut supervisor)["ok"], true);
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

fn wait_for_owned_job(root: &std::path::Path, pid: u32, request_id: u64) -> std::path::PathBuf {
    let deadline = Instant::now() + Duration::from_secs(2);
    let prefix = format!("job-{pid}-");
    let suffix = format!("-{request_id}");
    while Instant::now() < deadline {
        if let Some(path) = std::fs::read_dir(root)
            .unwrap()
            .filter_map(Result::ok)
            .find_map(|entry| {
                let name = entry.file_name();
                let name = name.to_str()?;
                (name.starts_with(&prefix) && name.ends_with(&suffix)).then(|| entry.path())
            })
        {
            return path;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    panic!(
        "owned job {prefix}*{suffix} was not created below {}",
        root.display()
    );
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
