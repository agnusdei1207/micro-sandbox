use micro_sandbox_native::resources::{ResourceFallbacks, ResourceSnapshot, admission_capacity};
use micro_sandbox_native::scheduler::{Capacity, ResourceRequest, Scheduler};
use std::sync::Arc;

#[test]
fn refuses_overcommit_and_releases_capacity_when_reservation_drops() {
    let scheduler = Scheduler::new(Capacity {
        memory_bytes: 100,
        cpu_millis: 1_000,
        pids: 10,
    });
    let first = scheduler
        .reserve(ResourceRequest {
            memory_bytes: 70,
            cpu_millis: 500,
            pids: 5,
        })
        .unwrap();

    assert_eq!(scheduler.reserved().memory_bytes, 70);
    assert_eq!(scheduler.available().memory_bytes, 30);
    assert_eq!(
        scheduler
            .reserve(ResourceRequest {
                memory_bytes: 31,
                cpu_millis: 100,
                pids: 1
            })
            .unwrap_err()
            .code(),
        "CAPACITY_EXCEEDED"
    );
    drop(first);
    assert_eq!(scheduler.reserved().memory_bytes, 0);
    assert!(
        scheduler
            .reserve(ResourceRequest {
                memory_bytes: 100,
                cpu_millis: 1_000,
                pids: 10
            })
            .is_ok()
    );
}

#[test]
fn concurrent_reservations_cannot_cross_the_limit() {
    let scheduler = Arc::new(Scheduler::new(Capacity {
        memory_bytes: 1,
        cpu_millis: 1,
        pids: 1,
    }));
    let mut threads = Vec::new();
    for _ in 0..16 {
        let scheduler = Arc::clone(&scheduler);
        threads.push(std::thread::spawn(move || {
            scheduler
                .reserve(ResourceRequest {
                    memory_bytes: 1,
                    cpu_millis: 1,
                    pids: 1,
                })
                .ok()
        }));
    }

    let reservations: Vec<_> = threads
        .into_iter()
        .filter_map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(reservations.len(), 1);
}

#[test]
fn live_capacity_shrink_accounts_for_existing_reservations_atomically() {
    let scheduler = Scheduler::new(Capacity {
        memory_bytes: 100,
        cpu_millis: 100,
        pids: 100,
    });
    let _first = scheduler
        .reserve(Capacity {
            memory_bytes: 40,
            cpu_millis: 40,
            pids: 40,
        })
        .unwrap();
    let request = Capacity {
        memory_bytes: 20,
        cpu_millis: 20,
        pids: 20,
    };
    let headroom = Capacity {
        memory_bytes: 50,
        cpu_millis: 50,
        pids: 50,
    };
    // The existing job is reserved but idle, so its whole reservation still competes
    // with the request for the shrunken live headroom.
    assert!(
        scheduler
            .reserve_with_limit(request, headroom, Capacity::default())
            .is_err()
    );
    // Once the job uses its reservation, live headroom already excludes that usage.
    let busy = Capacity {
        memory_bytes: 40,
        cpu_millis: 0,
        pids: 40,
    };
    let cpu_only_headroom = Capacity {
        cpu_millis: 60,
        ..headroom
    };
    assert!(
        scheduler
            .reserve_with_limit(request, headroom, busy)
            .is_err(),
        "CPU quota reservations are never offset by usage"
    );
    assert!(
        scheduler
            .reserve_with_limit(request, cpu_only_headroom, busy)
            .is_ok()
    );
}

#[test]
fn running_jobs_are_not_counted_twice_against_live_headroom() {
    const MIB: u64 = 1024 * 1024;
    let fallbacks = ResourceFallbacks {
        memory_bytes: u64::MAX,
        cpu_millis: 8_000,
        pids: 10_000,
    };
    let snapshot = |used_memory| ResourceSnapshot {
        memory_limit_bytes: Some(1024 * MIB),
        memory_current_bytes: used_memory,
        cpu_limit_millis: Some(4_000),
        pids_limit: Some(1_000),
        pids_current: 0,
    };
    // Admission starts from 80% of an idle 1 GiB cgroup.
    let scheduler = Scheduler::new(admission_capacity(snapshot(0), fallbacks));
    let job = |memory_bytes| Capacity {
        memory_bytes,
        cpu_millis: 100,
        pids: 1,
    };
    let _running = scheduler.reserve(job(400 * MIB)).unwrap();
    // The running job now uses all 400 MiB; the live snapshot already subtracts it.
    let live = admission_capacity(snapshot(400 * MIB), fallbacks);
    let own_usage = Capacity {
        memory_bytes: 400 * MIB,
        cpu_millis: 0,
        pids: 1,
    };
    // 400 MiB + 400 MiB fits both the 819 MiB static budget and the ~499 MiB live headroom
    // once the running job is not counted twice.
    let second = scheduler
        .reserve_with_limit(job(400 * MIB), live, own_usage)
        .expect("second job fits");
    drop(second);
    // The static budget still bounds the total reservations.
    assert!(
        scheduler
            .reserve_with_limit(job(450 * MIB), live, own_usage)
            .is_err()
    );
    // The live headroom still bounds a request that fits the static budget.
    let idle = Scheduler::new(admission_capacity(snapshot(0), fallbacks));
    assert!(
        idle.reserve_with_limit(job(500 * MIB), live, Capacity::default())
            .is_err()
    );
    assert!(
        idle.reserve_with_limit(job(499 * MIB), live, Capacity::default())
            .is_ok()
    );
}

#[test]
fn compares_a_request_with_a_live_capacity_snapshot() {
    let request = Capacity {
        memory_bytes: 64,
        cpu_millis: 500,
        pids: 8,
    };
    assert!(request.fits_within(Capacity {
        memory_bytes: 64,
        cpu_millis: 500,
        pids: 8,
    }));
    assert!(!request.fits_within(Capacity {
        memory_bytes: 63,
        cpu_millis: 500,
        pids: 8,
    }));
}
