use crate::config::ResourceLimits;
use crate::error::SandboxError;
use crate::linux::cgroup::Cgroup;
use crate::linux::clone::{CloneOutcome, RunningChild, clone_isolated};
use crate::linux::{capabilities, mount, seccomp};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::{self, File};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchSpec {
    pub job_id: String,
    pub rootfs: PathBuf,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "default_cwd")]
    pub cwd: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub stdin_base64: String,
    pub limits: ResourceLimits,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    exit_code: Option<i32>,
    signal: Option<i32>,
    timed_out: bool,
    output_limit_exceeded: bool,
    stdout_base64: String,
    stderr_base64: String,
    isolation: IsolationReport,
    metrics: JobMetrics,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IsolationReport {
    user_namespace: bool,
    pid_namespace: bool,
    mount_namespace: bool,
    network_namespace: bool,
    ipc_namespace: bool,
    uts_namespace: bool,
    cgroup_namespace: bool,
    cgroup_v2: bool,
    seccomp: bool,
    no_new_privileges: bool,
    capabilities_dropped: bool,
    pivot_root: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobMetrics {
    duration_ms: u64,
    peak_memory_bytes: u64,
}

pub fn launch(spec: LaunchSpec, cgroup_root: &Path) -> Result<LaunchResult, SandboxError> {
    let started = Instant::now();
    let (rootfs, stdin) = validate_spec(&spec)?;
    let staging_root = StagingRoot::create(&spec.job_id)?;
    let mut cgroup = Cgroup::create(cgroup_root, &spec.job_id, spec.limits)?;
    let cgroup_fd = cgroup.open_fd()?;
    let pipes = JobPipes::create()?;

    match clone_isolated(Some(cgroup_fd.as_raw_fd()))? {
        CloneOutcome::Child(child) => {
            let pipes = pipes.into_child();
            let outcome = child.wait_for_mapping().and_then(|()| {
                redirect_standard_streams(&pipes)?;
                mount::build_root(&rootfs, staging_root.path())?;
                change_directory(&spec.cwd)?;
                capabilities::drop_all()?;
                seccomp::apply_baseline()?;
                signal_ready(pipes.ready_write.as_raw_fd())?;
                exec(&spec)
            });
            child_exit(outcome)
        }
        CloneOutcome::Parent(parent) => {
            let pipes = pipes.into_parent();
            let child = parent.map_current_user_and_release()?;
            wait_until_ready(pipes.ready_read.as_raw_fd(), &child)?;
            supervise_child(child, pipes, stdin, &spec, &mut cgroup, started)
        }
    }
}

fn validate_spec(spec: &LaunchSpec) -> Result<(PathBuf, Vec<u8>), SandboxError> {
    if spec.limits.timeout_ms == 0 || spec.limits.output_bytes == 0 {
        return Err(SandboxError::PolicyViolation(
            "timeout and output limits must be positive".into(),
        ));
    }
    let command = Path::new(&spec.command);
    if !command.is_absolute()
        || command
            .components()
            .any(|component| !matches!(component, Component::RootDir | Component::Normal(_)))
    {
        return Err(SandboxError::PolicyViolation(
            "command must be a normalized absolute path".into(),
        ));
    }
    if spec.command.contains('\0') || spec.args.iter().any(|value| value.contains('\0')) {
        return Err(SandboxError::PolicyViolation(
            "command and arguments may not contain NUL".into(),
        ));
    }
    validate_guest_path(&spec.cwd, "working directory")?;
    if spec.env.len() > 128
        || spec.env.iter().any(|(name, value)| {
            !valid_environment_name(name)
                || value.contains('\0')
                || name.len().saturating_add(value.len()) > 16 * 1024
        })
    {
        return Err(SandboxError::PolicyViolation(
            "environment variables are invalid or too large".into(),
        ));
    }
    let stdin = base64::engine::general_purpose::STANDARD
        .decode(&spec.stdin_base64)
        .map_err(|_| SandboxError::PolicyViolation("stdin is not valid base64".into()))?;
    if stdin.len() as u64 > spec.limits.input_bytes {
        return Err(SandboxError::PolicyViolation(
            "stdin exceeds the input limit".into(),
        ));
    }
    let rootfs = fs::canonicalize(&spec.rootfs)?;
    if !rootfs.is_dir() {
        return Err(SandboxError::PolicyViolation(
            "runtime root must be a directory".into(),
        ));
    }
    let host_command = rootfs.join(command.strip_prefix("/").expect("absolute path"));
    if !host_command.is_file() {
        return Err(SandboxError::PolicyViolation(format!(
            "command does not exist in runtime: {}",
            spec.command
        )));
    }
    Ok((rootfs, stdin))
}

fn supervise_child(
    child: RunningChild,
    pipes: ParentPipes,
    stdin: Vec<u8>,
    spec: &LaunchSpec,
    cgroup: &mut Cgroup,
    started: Instant,
) -> Result<LaunchResult, SandboxError> {
    let input_writer = std::thread::spawn(move || {
        use std::io::Write;
        let mut file = File::from(pipes.stdin_write);
        file.write_all(&stdin)
    });
    let overflow = Arc::new(AtomicBool::new(false));
    let remaining = Arc::new(AtomicU64::new(spec.limits.output_bytes));
    let stdout_reader = read_stream(pipes.stdout_read, remaining.clone(), overflow.clone());
    let stderr_reader = read_stream(pipes.stderr_read, remaining, overflow.clone());
    let deadline = started + Duration::from_millis(spec.limits.timeout_ms);
    let mut timed_out = false;

    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline || overflow.load(Ordering::Acquire) {
            timed_out = Instant::now() >= deadline;
            child.send_signal(libc::SIGKILL)?;
            cgroup.kill_all()?;
            break child.wait()?;
        }
        std::thread::sleep(Duration::from_millis(2));
    };

    cgroup.kill_all()?;
    let peak_memory_bytes = cgroup.memory_peak_bytes().unwrap_or(0);
    let stdout = join_reader(stdout_reader)?;
    let stderr = join_reader(stderr_reader)?;
    input_writer
        .join()
        .map_err(|_| SandboxError::Security("input writer panicked".into()))?
        .or_else(|error| {
            if error.kind() == io::ErrorKind::BrokenPipe {
                Ok(())
            } else {
                Err(error)
            }
        })?;
    cgroup.cleanup()?;

    let (exit_code, signal) = if libc::WIFEXITED(status) {
        (Some(libc::WEXITSTATUS(status)), None)
    } else if libc::WIFSIGNALED(status) {
        (None, Some(libc::WTERMSIG(status)))
    } else {
        (None, None)
    };
    Ok(LaunchResult {
        exit_code,
        signal,
        timed_out,
        output_limit_exceeded: overflow.load(Ordering::Acquire),
        stdout_base64: base64::engine::general_purpose::STANDARD.encode(stdout),
        stderr_base64: base64::engine::general_purpose::STANDARD.encode(stderr),
        isolation: IsolationReport::complete(),
        metrics: JobMetrics {
            duration_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
            peak_memory_bytes,
        },
    })
}

fn read_stream(
    fd: OwnedFd,
    remaining: Arc<AtomicU64>,
    overflow: Arc<AtomicBool>,
) -> std::thread::JoinHandle<Result<Vec<u8>, io::Error>> {
    std::thread::spawn(move || {
        let mut file = File::from(fd);
        let capacity =
            usize::try_from(remaining.load(Ordering::Acquire).min(64 * 1024)).unwrap_or(64 * 1024);
        let mut output = Vec::with_capacity(capacity);
        let mut buffer = [0_u8; 8192];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            let keep = claim_output_bytes(&remaining, read);
            output.extend_from_slice(&buffer[..keep]);
            if keep < read {
                overflow.store(true, Ordering::Release);
            }
        }
        Ok(output)
    })
}

fn claim_output_bytes(remaining: &AtomicU64, requested: usize) -> usize {
    let requested = requested as u64;
    let mut available = remaining.load(Ordering::Acquire);
    loop {
        let claimed = requested.min(available);
        match remaining.compare_exchange_weak(
            available,
            available - claimed,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return usize::try_from(claimed).unwrap_or(usize::MAX),
            Err(current) => available = current,
        }
    }
}

fn join_reader(
    handle: std::thread::JoinHandle<Result<Vec<u8>, io::Error>>,
) -> Result<Vec<u8>, SandboxError> {
    handle
        .join()
        .map_err(|_| SandboxError::Security("output reader panicked".into()))?
        .map_err(SandboxError::Io)
}

fn wait_until_ready(fd: RawFd, child: &RunningChild) -> Result<(), SandboxError> {
    let mut byte = [0_u8];
    // SAFETY: fd is the readable end of the setup pipe and byte is writable.
    let result = unsafe { libc::read(fd, byte.as_mut_ptr().cast(), 1) };
    if result == 1 && byte[0] == 1 {
        return Ok(());
    }
    let _ = child.send_signal(libc::SIGKILL);
    Err(SandboxError::Security(
        "isolated child failed before completing security setup".into(),
    ))
}

fn redirect_standard_streams(pipes: &ChildPipes) -> Result<(), SandboxError> {
    for (source, target) in [
        (pipes.stdin_read.as_raw_fd(), libc::STDIN_FILENO),
        (pipes.stdout_write.as_raw_fd(), libc::STDOUT_FILENO),
        (pipes.stderr_write.as_raw_fd(), libc::STDERR_FILENO),
    ] {
        // SAFETY: source and target are valid file descriptors.
        if unsafe { libc::dup2(source, target) } == -1 {
            return Err(SandboxError::Io(io::Error::last_os_error()));
        }
    }
    Ok(())
}

fn signal_ready(fd: RawFd) -> Result<(), SandboxError> {
    let byte = [1_u8];
    // SAFETY: fd is the writable end of the setup pipe and byte is readable.
    if unsafe { libc::write(fd, byte.as_ptr().cast(), 1) } != 1 {
        return Err(SandboxError::Io(io::Error::last_os_error()));
    }
    Ok(())
}

fn exec(spec: &LaunchSpec) -> Result<(), SandboxError> {
    let command = CString::new(spec.command.as_bytes())
        .map_err(|_| SandboxError::PolicyViolation("command contains NUL".into()))?;
    let mut arguments = Vec::with_capacity(spec.args.len() + 1);
    arguments.push(command.clone());
    for argument in &spec.args {
        arguments.push(
            CString::new(argument.as_bytes()).map_err(|_| {
                SandboxError::PolicyViolation("command argument contains NUL".into())
            })?,
        );
    }
    let mut argv: Vec<_> = arguments.iter().map(|value| value.as_ptr()).collect();
    argv.push(std::ptr::null());
    let mut values = BTreeMap::from([
        (
            "PATH".to_string(),
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".to_string(),
        ),
        ("HOME".to_string(), "/tmp".to_string()),
        ("LANG".to_string(), "C.UTF-8".to_string()),
    ]);
    values.extend(spec.env.clone());
    let environment = values
        .iter()
        .map(|(name, value)| CString::new(format!("{name}={value}")))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| SandboxError::PolicyViolation("environment contains NUL".into()))?;
    let mut envp: Vec<_> = environment.iter().map(|value| value.as_ptr()).collect();
    envp.push(std::ptr::null());
    // SAFETY: command, argv, and envp are NUL-terminated and remain alive for the call.
    unsafe { libc::execve(command.as_ptr(), argv.as_ptr(), envp.as_ptr()) };
    Err(SandboxError::Io(io::Error::last_os_error()))
}

fn child_exit(result: Result<(), SandboxError>) -> ! {
    if let Err(error) = result {
        let message = format!("{}: {error}\n", error.code());
        // SAFETY: STDERR is configured or inherited and message is readable.
        unsafe {
            libc::write(libc::STDERR_FILENO, message.as_ptr().cast(), message.len());
        }
    }
    // SAFETY: this terminates only the cloned child without unwinding copied parent state.
    unsafe { libc::_exit(127) }
}

struct JobPipes {
    stdin_read: OwnedFd,
    stdin_write: OwnedFd,
    stdout_read: OwnedFd,
    stdout_write: OwnedFd,
    stderr_read: OwnedFd,
    stderr_write: OwnedFd,
    ready_read: OwnedFd,
    ready_write: OwnedFd,
}

struct ParentPipes {
    stdin_write: OwnedFd,
    stdout_read: OwnedFd,
    stderr_read: OwnedFd,
    ready_read: OwnedFd,
}

struct ChildPipes {
    stdin_read: OwnedFd,
    stdout_write: OwnedFd,
    stderr_write: OwnedFd,
    ready_write: OwnedFd,
}

impl JobPipes {
    fn create() -> Result<Self, SandboxError> {
        let (stdin_read, stdin_write) = pipe()?;
        let (stdout_read, stdout_write) = pipe()?;
        let (stderr_read, stderr_write) = pipe()?;
        let (ready_read, ready_write) = pipe()?;
        Ok(Self {
            stdin_read,
            stdin_write,
            stdout_read,
            stdout_write,
            stderr_read,
            stderr_write,
            ready_read,
            ready_write,
        })
    }

    fn into_child(self) -> ChildPipes {
        let Self {
            stdin_read,
            stdin_write,
            stdout_read,
            stdout_write,
            stderr_read,
            stderr_write,
            ready_read,
            ready_write,
        } = self;
        drop(stdin_write);
        drop(stdout_read);
        drop(stderr_read);
        drop(ready_read);
        ChildPipes {
            stdin_read,
            stdout_write,
            stderr_write,
            ready_write,
        }
    }

    fn into_parent(self) -> ParentPipes {
        let Self {
            stdin_read,
            stdin_write,
            stdout_read,
            stdout_write,
            stderr_read,
            stderr_write,
            ready_read,
            ready_write,
        } = self;
        drop(stdin_read);
        drop(stdout_write);
        drop(stderr_write);
        drop(ready_write);
        ParentPipes {
            stdin_write,
            stdout_read,
            stderr_read,
            ready_read,
        }
    }
}

fn pipe() -> Result<(OwnedFd, OwnedFd), SandboxError> {
    let mut descriptors = [-1; 2];
    // SAFETY: descriptors points to two writable integers.
    if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } == -1 {
        return Err(SandboxError::Io(io::Error::last_os_error()));
    }
    // SAFETY: pipe2 returned two new owned descriptors.
    Ok(unsafe {
        (
            OwnedFd::from_raw_fd(descriptors[0]),
            OwnedFd::from_raw_fd(descriptors[1]),
        )
    })
}

struct StagingRoot(PathBuf);

impl StagingRoot {
    fn create(job_id: &str) -> Result<Self, SandboxError> {
        Ok(Self(mount::create_staging_root(job_id)?))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for StagingRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}

impl IsolationReport {
    const fn complete() -> Self {
        Self {
            user_namespace: true,
            pid_namespace: true,
            mount_namespace: true,
            network_namespace: true,
            ipc_namespace: true,
            uts_namespace: true,
            cgroup_namespace: true,
            cgroup_v2: true,
            seccomp: true,
            no_new_privileges: true,
            capabilities_dropped: true,
            pivot_root: true,
        }
    }
}

fn default_cwd() -> String {
    "/".into()
}

fn validate_guest_path(path: &str, label: &str) -> Result<(), SandboxError> {
    let path = Path::new(path);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::RootDir | Component::Normal(_)))
    {
        return Err(SandboxError::PolicyViolation(format!(
            "{label} must be a normalized absolute path"
        )));
    }
    Ok(())
}

fn valid_environment_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'A'..=b'Z' | b'a'..=b'z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn change_directory(path: &str) -> Result<(), SandboxError> {
    let path = CString::new(path)
        .map_err(|_| SandboxError::PolicyViolation("working directory contains NUL".into()))?;
    // SAFETY: path is NUL-terminated and names a guest directory.
    if unsafe { libc::chdir(path.as_ptr()) } == -1 {
        return Err(SandboxError::Io(io::Error::last_os_error()));
    }
    Ok(())
}
