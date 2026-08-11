use crate::error::SandboxError;
use serde::Serialize;
use std::sync::{Arc, Mutex, MutexGuard};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    pub memory_bytes: u64,
    pub cpu_millis: u64,
    pub pids: u64,
}

pub type ResourceRequest = Capacity;

impl Capacity {
    fn checked_add(self, other: Self) -> Option<Self> {
        Some(Self {
            memory_bytes: self.memory_bytes.checked_add(other.memory_bytes)?,
            cpu_millis: self.cpu_millis.checked_add(other.cpu_millis)?,
            pids: self.pids.checked_add(other.pids)?,
        })
    }

    pub fn fits_within(self, limit: Self) -> bool {
        self.memory_bytes <= limit.memory_bytes
            && self.cpu_millis <= limit.cpu_millis
            && self.pids <= limit.pids
    }

    fn saturating_sub(self, other: Self) -> Self {
        Self {
            memory_bytes: self.memory_bytes.saturating_sub(other.memory_bytes),
            cpu_millis: self.cpu_millis.saturating_sub(other.cpu_millis),
            pids: self.pids.saturating_sub(other.pids),
        }
    }
}

#[derive(Debug)]
struct State {
    reserved: Capacity,
}

#[derive(Debug, Clone)]
pub struct Scheduler {
    limit: Capacity,
    state: Arc<Mutex<State>>,
}

impl Scheduler {
    pub fn new(limit: Capacity) -> Self {
        Self {
            limit,
            state: Arc::new(Mutex::new(State {
                reserved: Capacity::default(),
            })),
        }
    }

    pub fn reserve(&self, request: ResourceRequest) -> Result<Reservation, SandboxError> {
        let mut state = lock_unpoisoned(&self.state);
        let total = state
            .reserved
            .checked_add(request)
            .ok_or(SandboxError::CapacityExceeded)?;
        if !total.fits_within(self.limit) {
            return Err(SandboxError::CapacityExceeded);
        }
        state.reserved = total;
        Ok(Reservation {
            request,
            state: Arc::clone(&self.state),
            released: false,
        })
    }

    pub fn reserved(&self) -> Capacity {
        lock_unpoisoned(&self.state).reserved
    }

    pub fn available(&self) -> Capacity {
        self.limit.saturating_sub(self.reserved())
    }
}

#[derive(Debug)]
pub struct Reservation {
    request: ResourceRequest,
    state: Arc<Mutex<State>>,
    released: bool,
}

impl Reservation {
    pub fn release(mut self) {
        self.release_inner();
    }

    fn release_inner(&mut self) {
        if self.released {
            return;
        }
        let mut state = lock_unpoisoned(&self.state);
        state.reserved = state.reserved.saturating_sub(self.request);
        self.released = true;
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.release_inner();
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
