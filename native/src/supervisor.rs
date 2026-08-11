use crate::error::SandboxError;
use crate::job::LaunchSpec;
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
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

struct ActiveJob {
    pidfd: PidFd,
    job_id: String,
    _reservation: Reservation,
}

struct FinishedJob {
    request_id: u64,
    output: io::Result<Output>,
}

struct RuntimeContext {
    cgroup_root: PathBuf,
    scheduler: Scheduler,
}

pub fn supervise() -> Result<(), SandboxError> {
    let cgroup_root = cgroup_root()?;
    let context = RuntimeContext {
        scheduler: Scheduler::new(detect_admission_capacity(&cgroup_root)?),
        cgroup_root,
    };
    let (request_tx, request_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();
    std::thread::spawn(move || read_requests(request_tx));

    let stdout = io::stdout();
    let mut writer = BufWriter::new(stdout.lock());
    let mut active = HashMap::<u64, ActiveJob>::new();
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
    finished_tx: &Sender<FinishedJob>,
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
    finished_tx: &Sender<FinishedJob>,
    context: &RuntimeContext,
) -> Result<ActiveJob, SandboxError> {
    let spec: LaunchSpec = serde_json::from_value(payload)?;
    let request = resource_request(&spec)?;
    if !request.fits_within(detect_admission_capacity(&context.cgroup_root)?) {
        return Err(SandboxError::CapacityExceeded);
    }
    let reservation = context.scheduler.reserve(request)?;
    let executable = std::env::current_exe()?;
    let mut child = Command::new(executable)
        .arg("launch")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    serde_json::to_writer(
        child
            .stdin
            .take()
            .ok_or_else(|| SandboxError::Security("launcher stdin is unavailable".into()))?,
        &spec,
    )?;
    let pidfd = PidFd::open(i32::try_from(child.id()).map_err(|_| {
        SandboxError::Security("launcher PID does not fit platform PID type".into())
    })?)?;
    let job_id = spec.job_id.clone();
    let finished_tx = finished_tx.clone();
    std::thread::spawn(move || wait_for_job(child, request_id, finished_tx));
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

fn wait_for_job(child: Child, request_id: u64, sender: Sender<FinishedJob>) {
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

fn read_requests(sender: Sender<Result<Option<Request>, SandboxError>>) {
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
