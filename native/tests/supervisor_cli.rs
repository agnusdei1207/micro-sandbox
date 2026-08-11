use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn supervisor_answers_health_and_exits_on_shutdown() {
    if std::env::var_os("MICRO_SANDBOX_PRIVILEGED_TESTS").is_none() {
        return;
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_micro-sandbox"))
        .arg("supervise")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn supervisor");

    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(
            b"{\"version\":1,\"id\":1,\"type\":\"health\",\"payload\":{}}\n\
              {\"version\":1,\"id\":2,\"type\":\"shutdown\",\"payload\":{}}\n",
        )
        .unwrap();
    drop(stdin);

    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let responses: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["id"], 1);
    assert_eq!(responses[0]["result"]["status"], "ready");
    assert_eq!(responses[0]["result"]["protocolVersion"], 1);
    assert_eq!(responses[1]["id"], 2);
    assert_eq!(responses[1]["result"]["status"], "closed");
}
