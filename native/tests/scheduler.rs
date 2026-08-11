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
