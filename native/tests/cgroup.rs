#![cfg(target_os = "linux")]

use micro_sandbox_native::config::ResourceLimits;
use micro_sandbox_native::linux::cgroup::{Cgroup, CgroupMode, remove_job_dir};
use std::fs;
use tempfile::tempdir;

#[test]
fn configures_kills_and_removes_an_emulated_cgroup() {
    let root = tempdir().unwrap();
    let limits = ResourceLimits {
        timeout_ms: 5_000,
        memory_mb: 256,
        cpu: 0.5,
        pids: 16,
        input_bytes: 1,
        output_bytes: 1,
    };
    let mut cgroup = Cgroup::create_in(root.path(), "job-abc", limits, CgroupMode::Emulated)
        .expect("create cgroup");
    let path = cgroup.path().to_path_buf();

    assert_eq!(
        fs::read_to_string(path.join("memory.max")).unwrap(),
        "268435456\n"
    );
    assert_eq!(
        fs::read_to_string(path.join("memory.swap.max")).unwrap(),
        "0\n"
    );
    assert_eq!(
        fs::read_to_string(path.join("memory.oom.group")).unwrap(),
        "1\n"
    );
    assert_eq!(fs::read_to_string(path.join("pids.max")).unwrap(), "16\n");
    assert_eq!(
        fs::read_to_string(path.join("cpu.max")).unwrap(),
        "50000 100000\n"
    );

    cgroup.cleanup().unwrap();
    cgroup.cleanup().unwrap();
    assert!(!path.exists());
}

#[test]
fn drop_performs_best_effort_cleanup() {
    let root = tempdir().unwrap();
    let path;
    {
        let cgroup = Cgroup::create_in(
            root.path(),
            "job-drop",
            ResourceLimits::default(),
            CgroupMode::Emulated,
        )
        .unwrap();
        path = cgroup.path().to_path_buf();
        assert!(path.exists());
    }
    assert!(!path.exists());
}

#[test]
fn rejects_a_job_id_that_could_escape_the_delegated_root() {
    let root = tempdir().unwrap();
    let error = Cgroup::create_in(
        root.path(),
        "../escape",
        ResourceLimits::default(),
        CgroupMode::Emulated,
    )
    .unwrap_err();
    assert_eq!(error.code(), "POLICY_VIOLATION");
}

#[test]
fn rejects_cpu_quotas_the_kernel_would_refuse() {
    let root = tempdir().unwrap();
    for cpu in [0.001, 0.009, 1_025.0, f64::NAN, f64::INFINITY, -1.0] {
        let error = Cgroup::create_in(
            root.path(),
            "job-cpu",
            ResourceLimits {
                cpu,
                ..ResourceLimits::default()
            },
            CgroupMode::Emulated,
        )
        .unwrap_err();
        assert_eq!(error.code(), "POLICY_VIOLATION", "{cpu}");
        assert!(!root.path().join("job-cpu").exists(), "{cpu}");
    }
    let mut minimum = Cgroup::create_in(
        root.path(),
        "job-cpu",
        ResourceLimits {
            cpu: 0.01,
            ..ResourceLimits::default()
        },
        CgroupMode::Emulated,
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(minimum.path().join("cpu.max")).unwrap(),
        "1000 100000\n"
    );
    minimum.cleanup().unwrap();
}

#[test]
fn removing_a_missing_job_directory_succeeds() {
    let root = tempdir().unwrap();
    remove_job_dir(root.path(), "job-missing").unwrap();
    assert_eq!(
        remove_job_dir(root.path(), "../escape").unwrap_err().code(),
        "POLICY_VIOLATION"
    );
}
