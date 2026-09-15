#![cfg(target_os = "linux")]

use micro_sandbox_native::linux::pidfd::PidFd;
use std::process::Command;

#[test]
fn terminates_a_process_without_pid_reuse_races() {
    let mut child = Command::new("sleep").arg("30").spawn().unwrap();
    let pidfd = PidFd::open(child.id() as i32).expect("pidfd_open");

    pidfd.send_signal(libc::SIGKILL).expect("pidfd_send_signal");
    let status = child.wait().unwrap();
    assert!(!status.success());
}

#[test]
fn cancelling_an_already_reaped_process_is_harmless() {
    let mut child = Command::new("sleep").arg("30").spawn().unwrap();
    let pidfd = PidFd::open(child.id() as i32).unwrap();
    child.kill().unwrap();
    child.wait().unwrap();

    pidfd.send_signal(libc::SIGKILL).unwrap();
}
