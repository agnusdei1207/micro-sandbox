use crate::artifact;
use crate::config::ResourceLimits;
use crate::error::SandboxError;
use crate::job::LaunchSpec;
use crate::linux::cgroup::{self, remove_job_dir, validate_job_id};
use crate::linux::mount;
use crate::linux::pidfd::PidFd;
use crate::protocol::{
    MAX_FRAME_BYTES, PROTOCOL_VERSION, Request, Response, decode_request, encode_response,
};
use crate::resources::{detect_admission_capacity, jobs_usage};
use crate::scheduler::{Capacity, Reservation, Scheduler};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};

const MAX_ACTIVE_JOBS: usize = 64;
const JOB_OVERHEAD: Capacity = Capacity {
    memory_bytes: 16 * 1024 * 1024,
    cpu_millis: 25,
    pids: 3,
};

/// Everything the protocol loop waits for, delivered over one channel.
enum Event {
    Request(Result<Option<Request>, SandboxError>),
    Finished(FinishedJob),
}

struct FinishedJob {
    request_id: u64,
    output: io::Result<Output>,
    /// Result of removing the job's cgroup and staging root after the launcher exited.
    cleanup: Result<(), SandboxError>,
}

struct ActiveJob {
    pidfd: PidFd,
    job_id: String,
    cancelled: bool,
    _reservation: Reservation,
    _workspace_reservation: Option<WorkspaceReservation>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelPayload {
    request_id: u64,
}

/// Wire form of a launcher failure written to its stderr.
#[derive(Deserialize)]
struct LauncherFailure {
    error: LauncherErrorBody,
}

#[derive(Deserialize)]
struct LauncherErrorBody {
    code: String,
    message: String,
}

struct Supervisor<W: Write> {
    writer: W,
    events: SyncSender<Event>,
    cgroup_root: PathBuf,
    scheduler: Scheduler,
    owner_token: String,
    workspace_reserved: Arc<AtomicU64>,
    active: HashMap<u64, ActiveJob>,
    shutdown_id: Option<u64>,
    eof: bool,
}

pub fn supervise() -> Result<(), SandboxError> {
    let cgroup_root = cgroup::root_from_env()?;
    reconcile_stale_jobs(&cgroup_root)?;
    let scheduler = Scheduler::new(detect_admission_capacity(&cgroup_root)?);
    let owner_token = format!(
        "{}-{}",
        std::process::id(),
        process_start_time(std::process::id())?
    );
    // Room for one request plus one completion per job, so senders rarely block.
    let (events, receiver) = mpsc::sync_channel(2 * MAX_ACTIVE_JOBS);
    let request_events = events.clone();
    std::thread::spawn(move || read_requests(request_events));

    let stdout = io::stdout();
    let mut supervisor = Supervisor::new(
        BufWriter::new(stdout.lock()),
        events,
        cgroup_root,
        scheduler,
        owner_token,
    );
    supervisor.run(&receiver)
}

impl<W: Write> Supervisor<W> {
    fn new(
        writer: W,
        events: SyncSender<Event>,
        cgroup_root: PathBuf,
        scheduler: Scheduler,
        owner_token: String,
    ) -> Self {
        Self {
            writer,
            events,
            cgroup_root,
            scheduler,
            owner_token,
            workspace_reserved: Arc::new(AtomicU64::new(0)),
            active: HashMap::new(),
            shutdown_id: None,
            eof: false,
        }
    }

    fn run(&mut self, receiver: &Receiver<Event>) -> Result<(), SandboxError> {
        loop {
            if let Some(id) = self.shutdown_id.filter(|_| self.active.is_empty()) {
                return self.respond(&Response::success(id, json!({ "status": "closed" })));
            }
            if self.eof && self.active.is_empty() {
                return Ok(());
            }
            // The supervisor holds a sender itself, so the channel never disconnects.
            let Ok(event) = receiver.recv() else {
                return Ok(());
            };
            match event {
                Event::Request(Ok(Some(request))) => self.handle_request(request)?,
                Event::Request(Ok(None)) => {
                    self.eof = true;
                    self.cancel_all();
                }
                // An undecodable or oversized frame desynchronizes the stream.
                Event::Request(Err(error)) => return Err(error),
                Event::Finished(finished) => self.finish(finished)?,
            }
        }
    }

    /// Answers one request. Only failures to write a response are returned; request
    /// errors become correlated failure responses so other jobs keep running.
    fn handle_request(&mut self, request: Request) -> Result<(), SandboxError> {
        if self.shutdown_id.is_some() {
            return self.respond(&Response::failure(request.id, &SandboxError::Cancelled));
        }
        match request.kind.as_str() {
            "health" => {
                let response = Response::success(
                    request.id,
                    json!({
                        "status": "ready",
                        "protocolVersion": PROTOCOL_VERSION,
                        "pid": std::process::id(),
                        "activeJobs": self.active.len(),
                        "available": self.scheduler.available(),
                    }),
                );
                self.respond(&response)
            }
            "run" if self.active.contains_key(&request.id) => self.respond(&Response::failure(
                request.id,
                &SandboxError::Protocol("request ID is already active".into()),
            )),
            "run" if self.active.len() >= MAX_ACTIVE_JOBS => self.respond(&Response::failure(
                request.id,
                &SandboxError::CapacityExceeded,
            )),
            "run" => match self.start_job(request.id, request.payload) {
                Ok(job) => {
                    self.active.insert(request.id, job);
                    Ok(())
                }
                Err(error) => self.respond(&Response::failure(request.id, &error)),
            },
            "cancel" => self.cancel(request),
            "shutdown" => {
                self.shutdown_id = Some(request.id);
                self.cancel_all();
                Ok(())
            }
            _ => self.respond(&Response::failure(
                request.id,
                &SandboxError::Protocol(format!("unsupported request type {:?}", request.kind)),
            )),
        }
    }

    fn cancel(&mut self, request: Request) -> Result<(), SandboxError> {
        match serde_json::from_value::<CancelPayload>(request.payload) {
            Ok(payload) => {
                if let Some(job) = self.active.get_mut(&payload.request_id) {
                    job.cancelled = true;
                    if let Err(error) = job.pidfd.send_signal(libc::SIGKILL) {
                        log(format_args!(
                            "cancelling request {}: {error}",
                            payload.request_id
                        ));
                    }
                }
                Ok(())
            }
            Err(error) => {
                let error = SandboxError::Protocol(format!("invalid cancel payload: {error}"));
                if self.active.contains_key(&request.id) {
                    // The Node client reuses a run's ID for its cancel; answering here
                    // would settle that still-running job twice.
                    log(format_args!("request {}: {error}", request.id));
                    Ok(())
                } else {
                    self.respond(&Response::failure(request.id, &error))
                }
            }
        }
    }

    fn cancel_all(&mut self) {
        for (request_id, job) in &mut self.active {
            job.cancelled = true;
            if let Err(error) = job.pidfd.send_signal(libc::SIGKILL) {
                log(format_args!("cancelling request {request_id}: {error}"));
            }
        }
    }

    fn start_job(&mut self, request_id: u64, payload: Value) -> Result<ActiveJob, SandboxError> {
        let mut spec: LaunchSpec = serde_json::from_value(payload)
            .map_err(|error| SandboxError::Protocol(format!("invalid run payload: {error}")))?;
        // The native supervisor owns filesystem identifiers; caller input is never used as a path.
        spec.job_id = format!("job-{}-{request_id}", self.owner_token);
        validate_job_id(&spec.job_id)?;
        spec.limits
            .validate_transport_bounds()
            .map_err(|message| SandboxError::PolicyViolation(message.into()))?;
        let request = resource_request(spec.limits)?
            .checked_add(JOB_OVERHEAD)
            .ok_or(SandboxError::CapacityExceeded)?;
        let live_headroom = detect_admission_capacity(&self.cgroup_root)?;
        let own_usage = jobs_usage(
            &self.cgroup_root,
            self.active.values().map(|job| job.job_id.as_str()),
        );
        let reservation = self
            .scheduler
            .reserve_with_limit(request, live_headroom, own_usage)?;
        let workspace_reservation = spec
            .workspace
            .as_ref()
            .map(|workspace| {
                let output = artifact::resolve_output_directory(workspace)?;
                WorkspaceReservation::reserve(
                    self.workspace_reserved.clone(),
                    artifact::available_bytes(&output)?,
                    workspace.limits.output_bytes,
                )
            })
            .transpose()?;
        let pidfd = self.spawn_launcher(request_id, &spec)?;
        Ok(ActiveJob {
            pidfd,
            job_id: spec.job_id,
            cancelled: false,
            _reservation: reservation,
            _workspace_reservation: workspace_reservation,
        })
    }

    fn spawn_launcher(&self, request_id: u64, spec: &LaunchSpec) -> Result<PidFd, SandboxError> {
        let executable = std::env::current_exe()?;
        let (child_tx, child_rx) = mpsc::sync_channel::<Child>(1);
        let events = self.events.clone();
        let cgroup_root = self.cgroup_root.clone();
        let job_id = spec.job_id.clone();
        std::thread::Builder::new()
            .name(format!("micro-sandbox-wait-{request_id}"))
            .spawn(move || {
                if let Ok(child) = child_rx.recv() {
                    let output = child.wait_with_output();
                    // Cleanup may wait for killed tasks, so it stays off the protocol loop.
                    let cleanup = cleanup_job(&cgroup_root, &job_id);
                    let _ = events.send(Event::Finished(FinishedJob {
                        request_id,
                        output,
                        cleanup,
                    }));
                }
            })?;
        let mut command = Command::new(executable);
        command
            .arg("launch")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // SAFETY: pre_exec only calls async-signal-safe libc functions.
        unsafe {
            command.pre_exec(|| {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
                if libc::getppid() == 1 {
                    return Err(io::Error::from_raw_os_error(libc::EPIPE));
                }
                Ok(())
            });
        }
        let mut child = command.spawn()?;
        let setup = (|| {
            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| SandboxError::Security("launcher stdin is unavailable".into()))?;
            serde_json::to_writer(stdin, spec)?;
            let pid = i32::try_from(child.id()).map_err(|_| {
                SandboxError::Security("launcher PID does not fit platform PID type".into())
            })?;
            PidFd::open(pid)
        })();
        let error = match setup {
            Ok(pidfd) => match child_tx.send(child) {
                Ok(()) => return Ok(pidfd),
                Err(unsent) => {
                    child = unsent.0;
                    SandboxError::Security("launcher waiter stopped unexpectedly".into())
                }
            },
            Err(error) => error,
        };
        // Rare setup failure: no response is pending for this job, so clean up inline.
        let _ = child.kill();
        let _ = child.wait();
        if let Err(cleanup) = cleanup_job(&self.cgroup_root, &spec.job_id) {
            log(format_args!("request {request_id} cleanup: {cleanup}"));
        }
        Err(error)
    }

    fn finish(&mut self, finished: FinishedJob) -> Result<(), SandboxError> {
        let Some(job) = self.active.remove(&finished.request_id) else {
            return Ok(());
        };
        if let Err(error) = &finished.cleanup {
            log(format_args!(
                "job {} cleanup failed; a restarted supervisor reconciles it: {error}",
                job.job_id
            ));
        }
        let frame = if job.cancelled {
            encode_response(&Response::failure(
                finished.request_id,
                &SandboxError::Cancelled,
            ))?
        } else {
            match finished.output {
                Ok(output) if output.status.success() => {
                    match bounded_json(&output.stdout)
                        .and_then(|bytes| serde_json::from_slice(bytes).map_err(SandboxError::Json))
                    {
                        Ok(result) => job_success_frame(finished.request_id, result)?,
                        Err(error) => {
                            encode_response(&Response::failure(finished.request_id, &error))?
                        }
                    }
                }
                Ok(output) => encode_response(&Response::failure(
                    finished.request_id,
                    &launcher_error(&output.stderr),
                ))?,
                Err(error) => encode_response(&Response::failure(
                    finished.request_id,
                    &SandboxError::Io(error),
                ))?,
            }
        };
        self.write_frame(&frame)
    }

    fn respond(&mut self, response: &Response) -> Result<(), SandboxError> {
        let frame = encode_response(response)?;
        self.write_frame(&frame)
    }

    fn write_frame(&mut self, frame: &[u8]) -> Result<(), SandboxError> {
        self.writer.write_all(frame)?;
        self.writer.flush()?;
        Ok(())
    }
}

impl<W: Write> Drop for Supervisor<W> {
    fn drop(&mut self) {
        for job in self.active.values() {
            let _ = job.pidfd.send_signal(libc::SIGKILL);
            let _ = cleanup_job(&self.cgroup_root, &job.job_id);
        }
    }
}

struct WorkspaceReservation {
    reserved: Arc<AtomicU64>,
    bytes: u64,
}

impl WorkspaceReservation {
    fn reserve(reserved: Arc<AtomicU64>, available: u64, bytes: u64) -> Result<Self, SandboxError> {
        let usable = available.saturating_mul(80) / 100;
        let mut current = reserved.load(Ordering::Acquire);
        loop {
            let next = current
                .checked_add(bytes)
                .ok_or(SandboxError::CapacityExceeded)?;
            if next > usable {
                return Err(SandboxError::CapacityExceeded);
            }
            match reserved.compare_exchange_weak(current, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => return Ok(Self { reserved, bytes }),
                Err(actual) => current = actual,
            }
        }
    }
}

impl Drop for WorkspaceReservation {
    fn drop(&mut self) {
        self.reserved.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

fn resource_request(limits: ResourceLimits) -> Result<Capacity, SandboxError> {
    limits
        .cpu_quota_micros()
        .map_err(|message| SandboxError::PolicyViolation(message.into()))?;
    Ok(Capacity {
        memory_bytes: limits
            .memory_mb
            .checked_mul(1024 * 1024)
            .ok_or_else(|| SandboxError::PolicyViolation("memory limit overflows".into()))?,
        // Bounded by cpu_quota_micros, so the conversion cannot saturate.
        cpu_millis: (limits.cpu * 1000.0).ceil() as u64,
        pids: limits.pids,
    })
}

/// Recovers the structured error a launcher reports on stderr, falling back to an
/// isolation failure with the stderr tail when none can be parsed.
fn launcher_error(stderr: &[u8]) -> SandboxError {
    let text = bounded_text(stderr);
    text.lines()
        .rev()
        .find_map(|line| {
            let failure: LauncherFailure = serde_json::from_str(line).ok()?;
            SandboxError::from_wire(&failure.error.code, failure.error.message)
        })
        .unwrap_or_else(|| SandboxError::Security(format!("launcher failed: {text}")))
}

/// Encodes a successful job response, or a correlated failure when the complete
/// envelope exceeds the frame bound, so one large result cannot stop the supervisor.
fn job_success_frame(request_id: u64, result: Value) -> Result<Vec<u8>, SandboxError> {
    encode_response(&Response::success(request_id, result))
        .or_else(|error| encode_response(&Response::failure(request_id, &error)))
}

/// Removes a finished job's cgroup and any staging root its killed launcher left.
fn cleanup_job(cgroup_root: &Path, job_id: &str) -> Result<(), SandboxError> {
    let cgroup = remove_job_dir(cgroup_root, job_id);
    let staging = mount::remove_staging_roots(job_id).map_err(SandboxError::Io);
    cgroup.and(staging)
}

fn reconcile_stale_jobs(root: &Path) -> Result<(), SandboxError> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let Some(job_id) = name.to_str() else {
            continue;
        };
        if owner_is_dead(job_id)
            && let Err(error) = remove_job_dir(root, job_id)
        {
            log(format_args!("reconciling cgroup {job_id}: {error}"));
        }
    }
    match mount::staging_roots() {
        Ok(roots) => {
            for (job_id, path) in roots {
                if owner_is_dead(&job_id)
                    && let Err(error) = mount::remove_staging_root(&path)
                {
                    log(format_args!("reconciling {}: {error}", path.display()));
                }
            }
        }
        Err(error) => log(format_args!("listing staging roots: {error}")),
    }
    Ok(())
}

/// True only for supervisor-owned job IDs whose recorded owner process no longer exists.
fn owner_is_dead(job_id: &str) -> bool {
    job_owner(job_id).is_some_and(|(pid, start)| process_start_time(pid).ok() != Some(start))
}

fn job_owner(job_id: &str) -> Option<(u32, u64)> {
    let mut fields = job_id.strip_prefix("job-")?.split('-');
    let pid = fields.next()?.parse().ok()?;
    let start = fields.next()?.parse().ok()?;
    fields.next()?.parse::<u64>().ok()?;
    fields.next().is_none().then_some((pid, start))
}

fn process_start_time(pid: u32) -> Result<u64, SandboxError> {
    parse_start_time(&fs::read_to_string(format!("/proc/{pid}/stat"))?)
        .ok_or_else(|| SandboxError::Security(format!("process {pid} has an invalid stat record")))
}

/// Extracts field 22 (`starttime`) from a `/proc/<pid>/stat` record. The command name
/// may contain spaces and parentheses, so fields are counted after its last `)`.
fn parse_start_time(stat: &str) -> Option<u64> {
    let (_, after_name) = stat.rsplit_once(')')?;
    after_name.split_whitespace().nth(19)?.parse().ok()
}

fn read_requests(sender: SyncSender<Event>) {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    loop {
        let result = read_bounded_frame(&mut reader)
            .and_then(|frame| frame.map(|bytes| decode_request(&bytes)).transpose());
        let done = matches!(result, Ok(None) | Err(_));
        if sender.send(Event::Request(result)).is_err() || done {
            break;
        }
    }
}

fn read_bounded_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, SandboxError> {
    let mut frame = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Ok(Some(frame))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index);
        if frame.len().saturating_add(take) > MAX_FRAME_BYTES {
            return Err(SandboxError::Protocol("frame exceeds 1 MiB".into()));
        }
        frame.extend_from_slice(&available[..take]);
        reader.consume(take + usize::from(newline.is_some()));
        if newline.is_some() {
            return Ok(Some(frame));
        }
    }
}

fn bounded_json(bytes: &[u8]) -> Result<&[u8], SandboxError> {
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(SandboxError::Protocol(
            "launcher result exceeds 1 MiB".into(),
        ));
    }
    Ok(bytes)
}

fn bounded_text(bytes: &[u8]) -> String {
    let start = bytes.len().saturating_sub(64 * 1024);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

fn log(message: std::fmt::Arguments<'_>) {
    eprintln!("micro-sandbox supervisor: {message}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    fn parse_frames(stream: &[u8]) -> Vec<Value> {
        stream
            .split(|byte| *byte == b'\n')
            .filter(|frame| !frame.is_empty())
            .map(|frame| serde_json::from_slice(frame).unwrap())
            .collect()
    }

    #[test]
    fn oversized_success_envelope_becomes_a_correlated_job_failure() {
        // The launcher JSON fits exactly; adding a response envelope exceeds the bound.
        let result = json!({ "stdoutBase64": "x".repeat(MAX_FRAME_BYTES - 19) });
        let launcher_bytes = serde_json::to_vec(&result).unwrap();
        assert_eq!(launcher_bytes.len(), MAX_FRAME_BYTES);
        assert!(bounded_json(&launcher_bytes).is_ok());

        let mut stream = job_success_frame(41, result).unwrap();
        stream.extend(job_success_frame(42, json!({ "exitCode": 0 })).unwrap());
        let responses = parse_frames(&stream);
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["id"], 41);
        assert_eq!(responses[0]["error"]["code"], "PROTOCOL_ERROR");
        assert_eq!(responses[1]["id"], 42);
        assert_eq!(responses[1]["ok"], true);
    }

    #[test]
    fn reads_frames_split_across_small_buffers() {
        let input = b"{\"a\":1}\n{\"b\":2}\n";
        let mut reader = BufReader::with_capacity(3, &input[..]);
        assert_eq!(
            read_bounded_frame(&mut reader).unwrap().unwrap(),
            b"{\"a\":1}"
        );
        assert_eq!(
            read_bounded_frame(&mut reader).unwrap().unwrap(),
            b"{\"b\":2}"
        );
        assert!(read_bounded_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn returns_a_final_frame_without_a_newline_at_eof() {
        let mut reader = BufReader::with_capacity(2, &b"tail"[..]);
        assert_eq!(read_bounded_frame(&mut reader).unwrap().unwrap(), b"tail");
        assert!(read_bounded_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn rejects_oversized_frames_even_when_split() {
        let input = vec![b'x'; MAX_FRAME_BYTES + 1];
        let mut reader = BufReader::with_capacity(4096, &input[..]);
        assert_eq!(
            read_bounded_frame(&mut reader).unwrap_err().code(),
            "PROTOCOL_ERROR"
        );
        let mut exact = vec![b'x'; MAX_FRAME_BYTES];
        exact.push(b'\n');
        let mut reader = BufReader::with_capacity(4096, &exact[..]);
        assert_eq!(
            read_bounded_frame(&mut reader).unwrap().unwrap().len(),
            MAX_FRAME_BYTES
        );
    }

    #[test]
    fn parses_start_time_when_the_command_name_contains_parentheses_and_spaces() {
        let fields_after_name = (3..=52).map(|field| field.to_string()).collect::<Vec<_>>();
        let stat = format!("4242 (evil) 1 2 ) (x) {}\n", fields_after_name.join(" "));
        // Field 22 is the 20th field after the state field (field 3).
        assert_eq!(parse_start_time(&stat), Some(22));
        assert_eq!(parse_start_time("4242 no-parenthesis 1 2"), None);
        assert_eq!(parse_start_time("4242 (short) S 1"), None);
        assert!(process_start_time(std::process::id()).is_ok());
    }

    #[test]
    fn recognizes_only_supervisor_owned_job_ids() {
        assert_eq!(job_owner("job-12-345-6"), Some((12, 345)));
        for job_id in [
            "job-test",
            "job-1-2",
            "job-1-2-3-4",
            "other-1-2-3",
            "job-a-2-3",
        ] {
            assert_eq!(job_owner(job_id), None, "{job_id}");
        }
        let alive = format!(
            "job-{}-{}-1",
            std::process::id(),
            process_start_time(std::process::id()).unwrap()
        );
        assert!(!owner_is_dead(&alive));
        assert!(owner_is_dead(&format!("job-{}-1-1", std::process::id())));
        assert!(!owner_is_dead("job-test"));
    }

    #[test]
    fn workspace_reservations_share_eighty_percent_of_free_space() {
        let reserved = Arc::new(AtomicU64::new(0));
        let first = WorkspaceReservation::reserve(reserved.clone(), 1_000, 500).unwrap();
        assert_eq!(reserved.load(Ordering::Acquire), 500);
        assert_eq!(
            WorkspaceReservation::reserve(reserved.clone(), 1_000, 301)
                .err()
                .unwrap()
                .code(),
            "CAPACITY_EXCEEDED"
        );
        let second = WorkspaceReservation::reserve(reserved.clone(), 1_000, 300).unwrap();
        assert_eq!(reserved.load(Ordering::Acquire), 800);
        drop(first);
        assert_eq!(reserved.load(Ordering::Acquire), 300);
        drop(second);
        assert_eq!(reserved.load(Ordering::Acquire), 0);
        reserved.store(1, Ordering::Release);
        assert!(WorkspaceReservation::reserve(reserved.clone(), u64::MAX, u64::MAX).is_err());
        assert_eq!(reserved.load(Ordering::Acquire), 1);
    }

    #[test]
    fn resource_requests_reject_invalid_cpu_and_memory_values() {
        let valid = ResourceLimits::default();
        assert_eq!(
            resource_request(valid).unwrap(),
            Capacity {
                memory_bytes: 256 * 1024 * 1024,
                cpu_millis: 500,
                pids: 16,
            }
        );
        for cpu in [f64::NAN, f64::INFINITY, -1.0, 0.0, 0.001, 1e300, f64::MAX] {
            let error = resource_request(ResourceLimits { cpu, ..valid }).unwrap_err();
            assert_eq!(error.code(), "POLICY_VIOLATION", "{cpu}");
        }
        let error = resource_request(ResourceLimits {
            memory_mb: u64::MAX,
            ..valid
        })
        .unwrap_err();
        assert_eq!(error.code(), "POLICY_VIOLATION");
    }

    #[test]
    fn maps_structured_launcher_errors_to_their_codes() {
        let stderr = b"POLICY_VIOLATION: noise\n{\"error\":{\"code\":\"POLICY_VIOLATION\",\"message\":\"policy violation: x\"}}\n";
        let error = launcher_error(stderr);
        assert_eq!(error.code(), "POLICY_VIOLATION");
        assert_eq!(error.to_string(), "policy violation: x");
        for unparseable in [
            &b"segfault"[..],
            b"{\"error\":{\"code\":\"BOGUS\",\"message\":\"x\"}}",
            b"",
        ] {
            let error = launcher_error(unparseable);
            assert_eq!(error.code(), "ISOLATION_UNAVAILABLE");
            assert!(error.to_string().contains("launcher failed"));
        }
    }

    struct Harness {
        supervisor: Supervisor<Vec<u8>>,
        _receiver: Receiver<Event>,
        _root: tempfile::TempDir,
        sleeper: Child,
    }

    impl Harness {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let (events, receiver) = mpsc::sync_channel(2 * MAX_ACTIVE_JOBS);
            let scheduler = Scheduler::new(Capacity {
                memory_bytes: u64::MAX,
                cpu_millis: u64::MAX,
                pids: u64::MAX,
            });
            Self {
                supervisor: Supervisor::new(
                    Vec::new(),
                    events,
                    root.path().to_path_buf(),
                    scheduler,
                    "1-1".into(),
                ),
                _receiver: receiver,
                _root: root,
                sleeper: Command::new("sleep").arg("30").spawn().unwrap(),
            }
        }

        /// Registers a fake running job backed by a shared sleeping process.
        fn add_job(&mut self, request_id: u64) {
            let job = ActiveJob {
                pidfd: PidFd::open(self.sleeper.id() as i32).unwrap(),
                job_id: format!("job-1-1-{request_id}"),
                cancelled: false,
                _reservation: self
                    .supervisor
                    .scheduler
                    .reserve(Capacity::default())
                    .unwrap(),
                _workspace_reservation: None,
            };
            self.supervisor.active.insert(request_id, job);
        }

        fn request(&mut self, id: u64, kind: &str, payload: Value) {
            self.supervisor
                .handle_request(Request {
                    version: PROTOCOL_VERSION,
                    id,
                    kind: kind.into(),
                    payload,
                })
                .unwrap();
        }

        fn take_responses(&mut self) -> Vec<Value> {
            parse_frames(&std::mem::take(&mut self.supervisor.writer))
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = self.sleeper.kill();
            let _ = self.sleeper.wait();
        }
    }

    fn assert_failure(response: &Value, id: u64, code: &str) {
        assert_eq!(response["id"], id, "{response}");
        assert_eq!(response["ok"], false, "{response}");
        assert_eq!(response["error"]["code"], code, "{response}");
    }

    #[test]
    fn answers_unknown_request_types_with_a_protocol_error() {
        let mut harness = Harness::new();
        harness.request(5, "reboot", json!({}));
        harness.request(6, "", json!({}));
        let responses = harness.take_responses();
        assert_failure(&responses[0], 5, "PROTOCOL_ERROR");
        assert_failure(&responses[1], 6, "PROTOCOL_ERROR");
    }

    #[test]
    fn malformed_cancel_is_a_correlated_failure_not_a_fatal_error() {
        let mut harness = Harness::new();
        harness.add_job(7);
        harness.request(8, "cancel", json!({}));
        harness.request(9, "cancel", json!({ "requestId": "seven" }));
        // A malformed cancel reusing an active job's ID must not settle that job.
        harness.request(7, "cancel", json!({}));
        let responses = harness.take_responses();
        assert_eq!(responses.len(), 2);
        assert_failure(&responses[0], 8, "PROTOCOL_ERROR");
        assert_failure(&responses[1], 9, "PROTOCOL_ERROR");
        assert!(!harness.supervisor.active[&7].cancelled);

        harness.request(7, "cancel", json!({ "requestId": 7 }));
        harness.request(10, "cancel", json!({ "requestId": 404 }));
        assert!(harness.take_responses().is_empty());
        assert!(harness.supervisor.active[&7].cancelled);
    }

    #[test]
    fn rejects_duplicate_ids_bad_payloads_and_excess_jobs() {
        let mut harness = Harness::new();
        harness.add_job(1);
        harness.request(1, "run", json!({}));
        harness.request(2, "run", json!({ "unexpected": true }));
        for id in 3..=(MAX_ACTIVE_JOBS as u64 + 1) {
            harness.add_job(id);
        }
        harness.request(100, "run", json!({}));
        let responses = harness.take_responses();
        assert_failure(&responses[0], 1, "PROTOCOL_ERROR");
        assert!(
            responses[0]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("already active")
        );
        assert_failure(&responses[1], 2, "PROTOCOL_ERROR");
        assert_failure(&responses[2], 100, "CAPACITY_EXCEEDED");
        assert_eq!(harness.supervisor.active.len(), MAX_ACTIVE_JOBS);
    }

    #[test]
    fn shutdown_cancels_jobs_and_refuses_later_requests() {
        let mut harness = Harness::new();
        harness.add_job(1);
        harness.request(2, "shutdown", json!({}));
        harness.request(3, "health", json!({}));
        assert!(harness.supervisor.active[&1].cancelled);
        let responses = harness.take_responses();
        assert_eq!(responses.len(), 1);
        assert_failure(&responses[0], 3, "CANCELLED");
    }

    #[test]
    fn finished_jobs_respond_even_when_cleanup_fails() {
        let mut harness = Harness::new();
        harness.add_job(1);
        harness.add_job(2);
        harness.add_job(3);
        harness.supervisor.active.get_mut(&1).unwrap().cancelled = true;
        let failed = |stderr: &[u8]| Output {
            status: std::process::ExitStatus::from_raw(1 << 8),
            stdout: Vec::new(),
            stderr: stderr.to_vec(),
        };
        let finished = [
            (1, failed(b"")),
            (
                2,
                failed(
                    b"{\"error\":{\"code\":\"CGROUP_DELEGATION_REQUIRED\",\"message\":\"m\"}}\n",
                ),
            ),
            (
                3,
                Output {
                    status: std::process::ExitStatus::from_raw(0),
                    stdout: br#"{"exitCode":0}"#.to_vec(),
                    stderr: Vec::new(),
                },
            ),
        ];
        for (request_id, output) in finished {
            harness
                .supervisor
                .finish(FinishedJob {
                    request_id,
                    output: Ok(output),
                    cleanup: Err(SandboxError::Io(io::Error::from_raw_os_error(libc::EBUSY))),
                })
                .unwrap();
        }
        // A completion for an unknown request is ignored.
        harness
            .supervisor
            .finish(FinishedJob {
                request_id: 99,
                output: Err(io::Error::other("gone")),
                cleanup: Ok(()),
            })
            .unwrap();
        let responses = harness.take_responses();
        assert_eq!(responses.len(), 3);
        assert_failure(&responses[0], 1, "CANCELLED");
        assert_failure(&responses[1], 2, "CGROUP_DELEGATION_REQUIRED");
        assert_eq!(responses[2]["id"], 3);
        assert_eq!(responses[2]["result"]["exitCode"], 0);
        assert!(harness.supervisor.active.is_empty());
    }
}
