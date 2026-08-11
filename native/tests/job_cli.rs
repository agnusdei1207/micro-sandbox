#![cfg(target_os = "linux")]

use base64::Engine;
use serde_json::{Value, json};
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn runs_a_command_in_a_disposable_fully_isolated_job() {
    if std::env::var_os("MICRO_SANDBOX_PRIVILEGED_TESTS").is_none() {
        return;
    }
    let cgroup_root = std::env::var("MICRO_SANDBOX_CGROUP_ROOT").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_micro-sandbox"))
        .arg("launch")
        .env("MICRO_SANDBOX_CGROUP_ROOT", &cgroup_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let spec = json!({
        "jobId": "job-test",
        "rootfs": "/",
        "command": "/bin/sh",
        "args": ["-c", "printf sandbox; test ! -e /etc/hostname; test $$ -eq 1"],
        "limits": {
            "timeoutMs": 2000,
            "memoryMb": 64,
            "cpu": 0.5,
            "pids": 8,
            "inputBytes": 1024,
            "outputBytes": 1024
        }
    });
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&spec).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["exitCode"], 0);
    assert_eq!(result["timedOut"], false);
    let stdout = base64::engine::general_purpose::STANDARD
        .decode(result["stdoutBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(stdout, b"sandbox");
    for control in [
        "userNamespace",
        "pidNamespace",
        "mountNamespace",
        "networkNamespace",
        "ipcNamespace",
        "utsNamespace",
        "cgroupNamespace",
        "cgroupV2",
        "seccomp",
        "noNewPrivileges",
        "capabilitiesDropped",
        "pivotRoot",
    ] {
        assert_eq!(result["isolation"][control], true, "{control}");
    }
    assert!(!std::path::Path::new(&cgroup_root).join("job-test").exists());
}

#[test]
fn passes_bounded_input_environment_and_working_directory() {
    if std::env::var_os("MICRO_SANDBOX_PRIVILEGED_TESTS").is_none() {
        return;
    }
    let cgroup_root = std::env::var("MICRO_SANDBOX_CGROUP_ROOT").unwrap();
    let output = run_launch(
        &cgroup_root,
        json!({
            "jobId": "job-io",
            "rootfs": "/",
            "command": "/bin/sh",
            "args": ["-c", "IFS= read -r value; printf '%s:%s:%s' \"$GREETING\" \"$PWD\" \"$value\""],
            "cwd": "/tmp",
            "env": { "GREETING": "hello" },
            "stdinBase64": base64::engine::general_purpose::STANDARD.encode("input\n"),
            "limits": {
                "timeoutMs": 2000,
                "memoryMb": 64,
                "cpu": 0.5,
                "pids": 8,
                "inputBytes": 1024,
                "outputBytes": 1024
            }
        }),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let stdout = base64::engine::general_purpose::STANDARD
        .decode(result["stdoutBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(stdout, b"hello:/tmp:input");
}

#[test]
fn enforces_one_aggregate_output_limit_across_stdout_and_stderr() {
    if std::env::var_os("MICRO_SANDBOX_PRIVILEGED_TESTS").is_none() {
        return;
    }
    let cgroup_root = std::env::var("MICRO_SANDBOX_CGROUP_ROOT").unwrap();
    let output = run_launch(
        &cgroup_root,
        json!({
            "jobId": "job-output-limit",
            "rootfs": "/",
            "command": "/bin/sh",
            "args": ["-c", "head -c 800 /dev/zero; head -c 800 /dev/zero >&2"],
            "limits": {
                "timeoutMs": 2000,
                "memoryMb": 64,
                "cpu": 0.5,
                "pids": 8,
                "inputBytes": 1024,
                "outputBytes": 1024
            }
        }),
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let stdout = base64::engine::general_purpose::STANDARD
        .decode(result["stdoutBase64"].as_str().unwrap())
        .unwrap();
    let stderr = base64::engine::general_purpose::STANDARD
        .decode(result["stderrBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(result["outputLimitExceeded"], true, "{result}");
    assert!(stdout.len() + stderr.len() <= 1024);
}

#[test]
fn kills_a_timed_out_process_tree_and_cleans_its_cgroup() {
    if std::env::var_os("MICRO_SANDBOX_PRIVILEGED_TESTS").is_none() {
        return;
    }
    let cgroup_root = std::env::var("MICRO_SANDBOX_CGROUP_ROOT").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_micro-sandbox"))
        .arg("launch")
        .env("MICRO_SANDBOX_CGROUP_ROOT", &cgroup_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            let spec = json!({
                "jobId": "job-timeout",
                "rootfs": "/",
                "command": "/bin/sh",
                "args": ["-c", "trap '' TERM; (sleep 30) & wait"],
                "limits": {
                    "timeoutMs": 50,
                    "memoryMb": 64,
                    "cpu": 0.5,
                    "pids": 8,
                    "inputBytes": 1024,
                    "outputBytes": 1024
                }
            });
            child
                .stdin
                .take()
                .unwrap()
                .write_all(serde_json::to_string(&spec).unwrap().as_bytes())?;
            child.wait_with_output()
        })
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["timedOut"], true, "result: {result}");
    assert!(
        !std::path::Path::new(&cgroup_root)
            .join("job-timeout")
            .exists()
    );
}

fn run_launch(cgroup_root: &str, spec: Value) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_micro-sandbox"))
        .arg("launch")
        .env("MICRO_SANDBOX_CGROUP_ROOT", cgroup_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(serde_json::to_string(&spec).unwrap().as_bytes())?;
            child.wait_with_output()
        })
        .unwrap()
}
