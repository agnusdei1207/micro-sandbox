use micro_sandbox_native::resources::{ResourceSnapshot, parse_cpu_max, parse_limit};

#[test]
fn parses_cgroup_limits_without_confusing_max_for_zero() {
    assert_eq!(parse_limit("max\n").unwrap(), None);
    assert_eq!(parse_limit("536870912\n").unwrap(), Some(536_870_912));
    assert!(parse_limit("-1").is_err());
}

#[test]
fn parses_cpu_quota_as_millicores() {
    assert_eq!(parse_cpu_max("50000 100000\n").unwrap(), Some(500));
    assert_eq!(parse_cpu_max("max 100000\n").unwrap(), None);
    assert!(parse_cpu_max("100 bad").is_err());
}

#[test]
fn computes_headroom_with_saturating_arithmetic() {
    let snapshot = ResourceSnapshot {
        memory_limit_bytes: Some(512),
        memory_current_bytes: 500,
        cpu_limit_millis: Some(1_000),
        pids_limit: Some(32),
        pids_current: 40,
    };

    assert_eq!(snapshot.memory_headroom_bytes(), Some(12));
    assert_eq!(snapshot.pid_headroom(), Some(0));
}
