use crate::error::SandboxError;
use crate::job::LaunchSpec;
use crate::linux::cgroup::validate_job_id;
use crate::linux::pidfd::PidFd;
use crate::protocol::{
    MAX_FRAME_BYTES, PROTOCOL_VERSION, Request, Response, decode_request, encode_response,
};
use crate::resources::detect_admission_capacity;
use crate::scheduler::{Capacity, Reservation, Scheduler};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader, BufWriter, Write};
use std::ops::{Deref, DerefMut};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::time::{Duration, Instant};

struct ActiveJob {
    pidfd: PidFd,
    job_id: String,
    _reservation: Reservation,
}

struct ActiveJobs {
    jobs: HashMap<u64, ActiveJob>,
    cgroup_root: PathBuf,
}

impl Deref for ActiveJobs {
    type Target = HashMap<u64, ActiveJob>;
    fn deref(&self) -> &Self::Target {
        &self.jobs
    }
}

impl DerefMut for ActiveJobs {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.jobs
    }
}

impl Drop for ActiveJobs {
    fn drop(&mut self) {
        for job in self.jobs.values() {
            let _ = job.pidfd.send_signal(libc::SIGKILL);
            let _ = cleanup_cgroup(&self.cgroup_root, &job.job_id);
        }
    }
}

struct FinishedJob {
    request_id: u64,
    output: io::Result<Output>,
}

struct RuntimeContext {
    cgroup_root: PathBuf,
    scheduler: Scheduler,
    owner_token: String,
}

const MAX_ACTIVE_JOBS: usize = 64;
const JOB_OVERHEAD: Capacity = Capacity {
    memory_bytes: 16 * 1024 * 1024,
    cpu_millis: 25,
    pids: 3,
};

pub fn supervise() -> Result<(), SandboxError> {
    let cgroup_root = cgroup_root()?;
    reconcile_stale_jobs(&cgroup_root)?;
    let context = RuntimeContext {
        scheduler: Scheduler::new(detect_admission_capacity(&cgroup_root)?),
        owner_token: format!(
            "{}-{}",
            std::process::id(),
            process_start_time(std::process::id())?
        ),
        cgroup_root,
    };
    let (request_tx, request_rx) = mpsc::sync_channel(MAX_ACTIVE_JOBS);
    let (finished_tx, finished_rx) = mpsc::sync_channel(MAX_ACTIVE_JOBS);
    std::thread::spawn(move || read_requests(request_tx));

    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    let mut active = ActiveJobs {
        jobs: HashMap::new(),
        cgroup_root: context.cgroup_root.clone(),
    };
    let mut cancelled = HashSet::<u64>::new();
    let mut shutdown_id = None;
    let mut eof = false;

    loop {
        drain_finished(
            &finished_rx,
            &mut active,
            &mut cancelled,
            &context.cgroup_root,
            &mut writer,
        )?;
        if let Some(id) = shutdown_id.filter(|_| active.is_empty()) {
            let response = Response::success(id, json!({ "status": "closed" }));
            write_response(&mut writer, &response)?;
            return Ok(());
        }
        if eof && active.is_empty() {
            return Ok(());
        }

        match request_rx.recv_timeout(Duration::from_millis(2)) {
            Ok(Ok(Some(request))) => handle_request(
                request,
                &finished_tx,
                &context,
                &mut active,
                &mut cancelled,
                &mut shutdown_id,
                &mut writer,
            )?,
            Ok(Ok(None)) | Err(RecvTimeoutError::Disconnected) => {
                eof = true;
                cancel_all(&active, &mut cancelled);
            }
            Ok(Err(error)) => return Err(error),
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

fn handle_request(
    request: Request,
    finished_tx: &SyncSender<FinishedJob>,
    context: &RuntimeContext,
    active: &mut HashMap<u64, ActiveJob>,
    cancelled: &mut HashSet<u64>,
    shutdown_id: &mut Option<u64>,
    writer: &mut impl Write,
) -> Result<(), SandboxError> {
    if shutdown_id.is_some() {
        return write_response(
            writer,
            &Response::failure(request.id, &SandboxError::Cancelled),
        );
    }
    match request.kind.as_str() {
        "health" => write_response(
            writer,
            &Response::success(
                request.id,
                json!({
                    "status": "ready",
                    "protocolVersion": PROTOCOL_VERSION,
                    "pid": std::process::id(),
                    "activeJobs": active.len(),
                    "available": context.scheduler.available(),
                }),
            ),
        ),
        "run" if active.contains_key(&request.id) => write_response(
            writer,
            &Response::failure(
                request.id,
                &SandboxError::Protocol("request ID is already active".into()),
            ),
        ),
        "run" if active.len() >= MAX_ACTIVE_JOBS => write_response(
            writer,
            &Response::failure(request.id, &SandboxError::CapacityExceeded),
        ),
        "run" => match start_job(request.id, request.payload, finished_tx, context) {
            Ok(job) => {
                active.insert(request.id, job);
                Ok(())
            }
            Err(error) => write_response(writer, &Response::failure(request.id, &error)),
        },
        "cancel" => {
            let request_id = request
                .payload
                .get("requestId")
                .and_then(Value::as_u64)
                .ok_or_else(|| SandboxError::Protocol("cancel requestId is missing".into()))?;
            if let Some(job) = active.get(&request_id) {
                cancelled.insert(request_id);
                job.pidfd.send_signal(libc::SIGKILL)?;
            }
            Ok(())
        }
        "shutdown" => {
            *shutdown_id = Some(request.id);
            cancel_all(active, cancelled);
            Ok(())
        }
        _ => write_response(
            writer,
            &Response::failure(
                request.id,
                &SandboxError::Protocol(format!("unsupported request type {:?}", request.kind)),
            ),
        ),
    }
}

fn start_job(
    request_id: u64,
    payload: Value,
    finished_tx: &SyncSender<FinishedJob>,
    context: &RuntimeContext,
) -> Result<ActiveJob, SandboxError> {
    let mut spec: LaunchSpec = serde_json::from_value(payload)?;
    // The native supervisor owns filesystem identifiers; caller input is never used as a path.
    spec.job_id = format!("job-{}-{request_id}", context.owner_token);
    validate_job_id(&spec.job_id)?;
    spec.limits
        .validate_transport_bounds()
        .map_err(|message| SandboxError::PolicyViolation(message.into()))?;
    let request = resource_request(&spec)?
        .checked_add(JOB_OVERHEAD)
        .ok_or(SandboxError::CapacityExceeded)?;
    let live_capacity = detect_admission_capacity(&context.cgroup_root)?;
    let reservation = context
        .scheduler
        .reserve_with_limit(request, live_capacity)?;
    let executable = std::env::current_exe()?;
    let job_id = spec.job_id.clone();
    let (child_tx, child_rx) = mpsc::sync_channel::<Child>(1);
    let waiter_finished_tx = finished_tx.clone();
    std::thread::Builder::new()
        .name(format!("micro-sandbox-wait-{request_id}"))
        .spawn(move || {
            if let Ok(child) = child_rx.recv() {
                wait_for_job(child, request_id, waiter_finished_tx);
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
        serde_json::to_writer(stdin, &spec)?;
        let pid = i32::try_from(child.id()).map_err(|_| {
            SandboxError::Security("launcher PID does not fit platform PID type".into())
        })?;
        PidFd::open(pid)
    })();
    let pidfd = match setup {
        Ok(pidfd) => pidfd,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = cleanup_cgroup(&context.cgroup_root, &job_id);
            return Err(error);
        }
    };
    if let Err(error) = child_tx.send(child) {
        let mut child = error.0;
        let _ = child.kill();
        let _ = child.wait();
        let _ = cleanup_cgroup(&context.cgroup_root, &job_id);
        return Err(SandboxError::Security(
            "launcher waiter stopped unexpectedly".into(),
        ));
    }
    Ok(ActiveJob {
        pidfd,
        job_id,
        _reservation: reservation,
    })
}

fn resource_request(spec: &LaunchSpec) -> Result<Capacity, SandboxError> {
    if !spec.limits.cpu.is_finite() || spec.limits.cpu <= 0.0 {
        return Err(SandboxError::PolicyViolation(
            "CPU limit must be positive and finite".into(),
        ));
    }
    Ok(Capacity {
        memory_bytes: spec
            .limits
            .memory_mb
            .checked_mul(1024 * 1024)
            .ok_or_else(|| SandboxError::PolicyViolation("memory limit overflows".into()))?,
        cpu_millis: (spec.limits.cpu * 1000.0).ceil() as u64,
        pids: spec.limits.pids,
    })
}

fn wait_for_job(child: Child, request_id: u64, sender: SyncSender<FinishedJob>) {
    let output = child.wait_with_output();
    let _ = sender.send(FinishedJob { request_id, output });
}

fn drain_finished(
    receiver: &Receiver<FinishedJob>,
    active: &mut HashMap<u64, ActiveJob>,
    cancelled: &mut HashSet<u64>,
    cgroup_root: &Path,
    writer: &mut impl Write,
) -> Result<(), SandboxError> {
    while let Ok(finished) = receiver.try_recv() {
        let Some(job) = active.remove(&finished.request_id) else {
            continue;
        };
        if cancelled.remove(&finished.request_id) {
            cleanup_cgroup(cgroup_root, &job.job_id)?;
            write_response(
                writer,
                &Response::failure(finished.request_id, &SandboxError::Cancelled),
            )?;
            continue;
        }
        let response = match finished.output {
            Ok(output) if output.status.success() => {
                match bounded_json(&output.stdout)
                    .and_then(|bytes| serde_json::from_slice(bytes).map_err(SandboxError::Json))
                {
                    Ok(result) => Response::success(finished.request_id, result),
                    Err(error) => Response::failure(finished.request_id, &error),
                }
            }
            Ok(output) => {
                let message = bounded_text(&output.stderr);
                Response::failure(
                    finished.request_id,
                    &SandboxError::Security(format!("launcher failed: {message}")),
                )
            }
            Err(error) => Response::failure(finished.request_id, &SandboxError::Io(error)),
        };
        cleanup_cgroup(cgroup_root, &job.job_id)?;
        write_response(writer, &response)?;
    }
    Ok(())
}

fn cancel_all(active: &HashMap<u64, ActiveJob>, cancelled: &mut HashSet<u64>) {
    for (&request_id, job) in active {
        cancelled.insert(request_id);
        let _ = job.pidfd.send_signal(libc::SIGKILL);
    }
}

fn cleanup_cgroup(root: &Path, job_id: &str) -> Result<(), SandboxError> {
    validate_job_id(job_id)?;
    let path = root.join(job_id);
    if !path.exists() {
        return Ok(());
    }
    let _ = fs::write(path.join("cgroup.kill"), "1\n");
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match fs::remove_dir(&path) {
            Ok(()) => return Ok(()),
            Err(error)
                if matches!(error.raw_os_error(), Some(libc::EBUSY))
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(SandboxError::Io(error)),
        }
    }
}

fn reconcile_stale_jobs(root: &Path) -> Result<(), SandboxError> {
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let job_id = name.to_str().ok_or_else(|| {
            SandboxError::CgroupUnavailable("cgroup job name is not UTF-8".into())
        })?;
        let Some((owner_pid, owner_start)) = job_owner(job_id) else {
            continue;
        };
        if process_start_time(owner_pid).ok() == Some(owner_start) {
            continue;
        }
        cleanup_cgroup(root, job_id)?;
    }
    Ok(())
}

fn job_owner(job_id: &str) -> Option<(u32, u64)> {
    let mut fields = job_id.strip_prefix("job-")?.split('-');
    let pid = fields.next()?.parse().ok()?;
    let start = fields.next()?.parse().ok()?;
    fields.next()?.parse::<u64>().ok()?;
    fields.next().is_none().then_some((pid, start))
}

fn process_start_time(pid: u32) -> Result<u64, SandboxError> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let after_name = stat.rsplit_once(')').map(|(_, rest)| rest).ok_or_else(|| {
        SandboxError::Security(format!("process {pid} has an invalid stat record"))
    })?;
    after_name
        .split_whitespace()
        .nth(19)
        .ok_or_else(|| SandboxError::Security(format!("process {pid} start time is missing")))?
        .parse()
        .map_err(|_| SandboxError::Security(format!("process {pid} start time is invalid")))
}

fn read_requests(sender: SyncSender<Result<Option<Request>, SandboxError>>) {
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    loop {
        let result = read_bounded_frame(&mut reader)
            .and_then(|frame| frame.map(|bytes| decode_request(&bytes)).transpose());
        let done = matches!(result, Ok(None) | Err(_));
        if sender.send(result).is_err() || done {
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

fn write_response(writer: &mut impl Write, response: &Response) -> Result<(), SandboxError> {
    writer.write_all(&encode_response(response)?)?;
    writer.flush()?;
    Ok(())
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

fn cgroup_root() -> Result<PathBuf, SandboxError> {
    std::env::var_os("MICRO_SANDBOX_CGROUP_ROOT")
        .map(PathBuf::from)
        .ok_or_else(|| {
            SandboxError::CgroupUnavailable("MICRO_SANDBOX_CGROUP_ROOT is not set".into())
        })
}
