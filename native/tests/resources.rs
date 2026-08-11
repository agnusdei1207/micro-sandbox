use micro_sandbox_native::resources::{
    ResourceFallbacks, ResourceSnapshot, admission_capacity, parse_cpu_max, parse_limit,
};

#[test]
fn parses_cgroup_limits_without_confusing_max_for_zero() {
    assert_eq!(parse_limit("max\n").unwrap(), None);
    assert_eq!(parse_limit("536870912\n").unwrap(), Some(536_870_912));
    assert!(parse_limit("-1").is_err());
}

#[test]
fn computes_a_conservative_admission_budget_from_current_headroom() {
    let capacity = admission_capacity(
        ResourceSnapshot {
            memory_limit_bytes: Some(1_000),
            memory_current_bytes: 200,
            cpu_limit_millis: Some(2_000),
            pids_limit: Some(100),
            pids_current: 20,
        },
        ResourceFallbacks {
            memory_bytes: 9_999,
            cpu_millis: 8_000,
            pids: 1_000,
        },
    );

    assert_eq!(capacity.memory_bytes, 640);
    assert_eq!(capacity.cpu_millis, 1_600);
    assert_eq!(capacity.pids, 64);
}

#[test]
fn uses_host_fallbacks_when_the_parent_cgroup_is_unbounded() {
    let capacity = admission_capacity(
        ResourceSnapshot {
            memory_limit_bytes: None,
            memory_current_bytes: 10,
            cpu_limit_millis: None,
            pids_limit: None,
            pids_current: 10,
        },
        ResourceFallbacks {
            memory_bytes: 1_000,
            cpu_millis: 4_000,
            pids: 500,
        },
    );

    assert_eq!(capacity.memory_bytes, 800);
    assert_eq!(capacity.cpu_millis, 3_200);
    assert_eq!(capacity.pids, 400);
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
