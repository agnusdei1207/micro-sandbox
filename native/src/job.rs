use crate::artifact::{self, ArtifactManifestEntry, ValidatedWorkspace, WorkspaceSpec};
use crate::config::ResourceLimits;
use crate::error::SandboxError;
use crate::linux::cgroup::{Cgroup, validate_job_id};
use crate::linux::clone::{CloneOutcome, RunningChild, clone_isolated, wait_until_ready};
use crate::linux::{self, mount, write_byte};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Interval for artifact-tree checks and memory sampling while a guest runs.
const MONITOR_INTERVAL: Duration = Duration::from_millis(20);

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchSpec {
    /// Filesystem identifier for the job. The supervisor always replaces it with an
    /// owned value, so callers may omit it.
    #[serde(default)]
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
    #[serde(default)]
    pub workspace: Option<WorkspaceSpec>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    exit_code: Option<i32>,
    signal: Option<i32>,
    timed_out: bool,
    output_limit_exceeded: bool,
    oom_killed: bool,
    stdout_base64: String,
    stderr_base64: String,
    isolation: IsolationReport,
    metrics: JobMetrics,
    artifacts: Vec<ArtifactManifestEntry>,
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
    validate_job_id(&spec.job_id)?;
    let (rootfs, stdin, workspace) = validate_spec(&spec)?;
    let staging_root = StagingRoot::create(&spec.job_id)?;
    let mut cgroup = Cgroup::create(cgroup_root, &spec.job_id, spec.limits)?;
    let cgroup_fd = cgroup.open_fd()?;
    let pipes = JobPipes::create()?;

    match clone_isolated(Some(cgroup_fd.as_raw_fd()))? {
        CloneOutcome::Child(child) => {
            let pipes = pipes.into_child();
            // Never unwind out of the child: that would run copies of the parent's guards.
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                child.wait_for_mapping()?;
                mount::build_root(&rootfs, staging_root.path(), workspace.as_ref())?;
                change_directory(&spec.cwd)?;
                linux::harden(workspace.as_ref().and_then(|value| value.file_size_limit))?;
                // Redirect last so setup failures still reach the launcher's stderr.
                redirect_standard_streams(&pipes)?;
                write_byte(pipes.ready_write.as_raw_fd(), 1)?;
                exec(&spec)
            }))
            .unwrap_or_else(|_| Err(SandboxError::Security("isolated child panicked".into())));
            child_exit(outcome)
        }
        CloneOutcome::Parent(parent) => {
            let pipes = pipes.into_parent();
            let deadline = started + Duration::from_millis(spec.limits.timeout_ms);
            let child = parent.map_current_user_and_release(deadline)?;
            wait_until_ready(pipes.ready_read.as_raw_fd(), child.pidfd(), deadline)?;
            supervise_child(
                child,
                pipes,
                stdin,
                &spec,
                workspace.as_ref(),
                &mut cgroup,
                started,
            )
        }
    }
}

fn validate_spec(
    spec: &LaunchSpec,
) -> Result<(PathBuf, Vec<u8>, Option<ValidatedWorkspace>), SandboxError> {
    if spec.limits.timeout_ms == 0 {
        return Err(SandboxError::PolicyViolation(
            "timeout limit must be positive".into(),
        ));
    }
    spec.limits
        .validate_transport_bounds()
        .map_err(|message| SandboxError::PolicyViolation(message.into()))?;
    validate_guest_path(&spec.command, "command")?;
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
    if !is_runtime_file(&rootfs, &spec.command) {
        return Err(SandboxError::PolicyViolation(format!(
            "command does not exist in runtime: {}",
            spec.command
        )));
    }
    let workspace = spec
        .workspace
        .as_ref()
        .map(artifact::validate_workspace)
        .transpose()?;
    Ok((rootfs, stdin, workspace))
}

/// Checks that `command` names a regular file when resolved as the guest would,
/// with absolute symlinks interpreted relative to `rootfs` rather than the host root.
fn is_runtime_file(rootfs: &Path, command: &str) -> bool {
    let Ok(root) = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(rootfs)
    else {
        return false;
    };
    let Ok(relative) = CString::new(command.trim_start_matches('/')) else {
        return false;
    };
    // SAFETY: open_how contains only integers, for which all-zero bytes are valid.
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = (libc::O_PATH | libc::O_CLOEXEC) as u64;
    how.resolve = libc::RESOLVE_IN_ROOT | libc::RESOLVE_NO_MAGICLINKS;
    // SAFETY: root is an open directory, relative is NUL-terminated, and how is a valid
    // open_how whose size is passed explicitly.
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root.as_raw_fd(),
            relative.as_ptr(),
            &how as *const libc::open_how,
            std::mem::size_of::<libc::open_how>(),
        )
    };
    if fd < 0 {
        return false;
    }
    // SAFETY: a successful openat2 returns a new descriptor owned by this function.
    let file = File::from(unsafe { OwnedFd::from_raw_fd(fd as RawFd) });
    file.metadata().is_ok_and(|metadata| metadata.is_file())
}

fn supervise_child(
    mut child: RunningChild,
    pipes: ParentPipes,
    stdin: Vec<u8>,
    spec: &LaunchSpec,
    workspace: Option<&ValidatedWorkspace>,
    cgroup: &mut Cgroup,
    started: Instant,
) -> Result<LaunchResult, SandboxError> {
    let input_writer = std::thread::spawn(move || {
        use std::io::Write;
        let mut file = File::from(pipes.stdin_write);
        file.write_all(&stdin)
    });
    let (wake_read, wake_write) = linux::pipe()?;
    let wake_write = Arc::new(wake_write);
    let overflow = Arc::new(AtomicBool::new(false));
    let remaining = Arc::new(AtomicU64::new(spec.limits.output_bytes));
    let stdout_reader = read_stream(
        pipes.stdout_read,
        remaining.clone(),
        overflow.clone(),
        wake_write.clone(),
    );
    let stderr_reader = read_stream(pipes.stderr_read, remaining, overflow.clone(), wake_write);
    let deadline = started + Duration::from_millis(spec.limits.timeout_ms);
    let mut timed_out = false;
    let mut observed_peak_memory = cgroup.memory_current_bytes().unwrap_or(0);
    let mut artifact_error = None;
    let mut next_check = Instant::now();

    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        let now = Instant::now();
        if now >= next_check {
            observed_peak_memory =
                observed_peak_memory.max(cgroup.memory_current_bytes().unwrap_or(0));
            if let (Some(workspace), Some(workspace_spec)) = (workspace, &spec.workspace)
                && let Err(error) = artifact::validate_outputs(workspace, workspace_spec.limits)
            {
                artifact_error = Some(error);
                child.send_signal(libc::SIGKILL)?;
                cgroup.kill_all()?;
                break child.wait()?;
            }
            next_check = now + MONITOR_INTERVAL;
        }
        if now >= deadline || overflow.load(Ordering::Acquire) {
            timed_out = now >= deadline;
            child.send_signal(libc::SIGKILL)?;
            cgroup.kill_all()?;
            break child.wait()?;
        }
        wait_for_event(
            child.pidfd(),
            wake_read.as_raw_fd(),
            deadline.min(next_check).saturating_duration_since(now),
        )?;
    };

    cgroup.kill_all()?;
    let peak_memory_bytes = cgroup.memory_peak_bytes().unwrap_or(observed_peak_memory);
    let oom_killed = cgroup.oom_killed();
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
    if let Some(error) = artifact_error {
        return Err(error);
    }
    let artifacts = match (workspace, &spec.workspace) {
        (Some(workspace), Some(workspace_spec)) => {
            artifact::collect_outputs(workspace, workspace_spec.limits)?
        }
        _ => Vec::new(),
    };

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
        oom_killed,
        stdout_base64: base64::engine::general_purpose::STANDARD.encode(stdout),
        stderr_base64: base64::engine::general_purpose::STANDARD.encode(stderr),
        isolation: IsolationReport::complete(),
        metrics: JobMetrics {
            duration_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
            peak_memory_bytes,
        },
        artifacts,
    })
}

/// Sleeps until the guest exits, an output reader reports overflow, or `timeout` passes.
fn wait_for_event(pidfd: RawFd, wake: RawFd, timeout: Duration) -> Result<(), SandboxError> {
    let mut descriptors = [pidfd, wake].map(|fd| libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    });
    // Round up so a sub-millisecond remainder does not become a busy loop.
    let timeout = i32::try_from(timeout.as_micros().div_ceil(1000)).unwrap_or(i32::MAX);
    // SAFETY: descriptors points to two initialized pollfd values.
    let result = unsafe { libc::poll(descriptors.as_mut_ptr(), descriptors.len() as _, timeout) };
    if result == -1 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(SandboxError::Io(error));
        }
    }
    Ok(())
}

fn read_stream(
    fd: OwnedFd,
    remaining: Arc<AtomicU64>,
    overflow: Arc<AtomicBool>,
    wake: Arc<OwnedFd>,
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
            // Only the first overflow wakes the monitor, so the wake pipe never fills.
            if keep < read && !overflow.swap(true, Ordering::AcqRel) {
                let _ = write_byte(wake.as_raw_fd(), 1);
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
            "PATH",
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        ),
        ("HOME", "/tmp"),
        ("LANG", "C.UTF-8"),
    ]);
    values.extend(
        spec.env
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str())),
    );
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
        let (stdin_read, stdin_write) = linux::pipe()?;
        let (stdout_read, stdout_write) = linux::pipe()?;
        let (stderr_read, stderr_write) = linux::pipe()?;
        let (ready_read, ready_write) = linux::pipe()?;
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
            stdout_write,
            stderr_write,
            ready_write,
            ..
        } = self;
        ChildPipes {
            stdin_read,
            stdout_write,
            stderr_write,
            ready_write,
        }
    }

    fn into_parent(self) -> ParentPipes {
        let Self {
            stdin_write,
            stdout_read,
            stderr_read,
            ready_read,
            ..
        } = self;
        ParentPipes {
            stdin_write,
            stdout_read,
            stderr_read,
            ready_read,
        }
    }
}

/// Owns a job's empty staging directory and removes it on every launcher exit path.
/// If the launcher is killed, the supervisor removes it instead.
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
        let _ = mount::remove_staging_root(&self.0);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn spec(command: &str) -> LaunchSpec {
        LaunchSpec {
            job_id: String::new(),
            rootfs: PathBuf::from("/"),
            command: command.into(),
            args: Vec::new(),
            cwd: default_cwd(),
            env: BTreeMap::new(),
            stdin_base64: String::new(),
            limits: ResourceLimits {
                input_bytes: 4,
                ..ResourceLimits::default()
            },
            workspace: None,
        }
    }

    fn rejection(spec: &LaunchSpec) -> String {
        match validate_spec(spec) {
            Ok(_) => panic!("specification was accepted"),
            Err(error) => {
                assert_eq!(error.code(), "POLICY_VIOLATION", "{error}");
                error.to_string()
            }
        }
    }

    #[test]
    fn accepts_portable_environment_names_only() {
        for name in ["A", "_", "_private", "PATH", "a1_B2"] {
            assert!(valid_environment_name(name), "{name}");
        }
        for name in ["", "1A", "A-B", "A=B", "A B", "É", "A.B"] {
            assert!(!valid_environment_name(name), "{name}");
        }
    }

    #[test]
    fn accepts_a_command_present_in_the_runtime() {
        assert!(validate_spec(&spec("/bin/sh")).is_ok());
    }

    #[test]
    fn rejects_invalid_launch_specifications() {
        let mut cases = Vec::new();
        let mut zero_timeout = spec("/bin/sh");
        zero_timeout.limits.timeout_ms = 0;
        cases.push((zero_timeout, "timeout"));
        let mut transport = spec("/bin/sh");
        transport.limits.output_bytes = 0;
        cases.push((transport, "output limit"));
        for command in ["bin/sh", "/bin/../bin/sh", "./bin/sh", ""] {
            cases.push((spec(command), "command must be"));
        }
        let mut nul_argument = spec("/bin/sh");
        nul_argument.args.push("a\0b".into());
        cases.push((nul_argument, "NUL"));
        let mut relative_cwd = spec("/bin/sh");
        relative_cwd.cwd = "tmp".into();
        cases.push((relative_cwd, "working directory"));
        let mut bad_name = spec("/bin/sh");
        bad_name.env.insert("1BAD".into(), "x".into());
        cases.push((bad_name, "environment"));
        let mut nul_value = spec("/bin/sh");
        nul_value.env.insert("GOOD".into(), "a\0b".into());
        cases.push((nul_value, "environment"));
        let mut too_many = spec("/bin/sh");
        too_many.env = (0..129)
            .map(|index| (format!("V{index}"), String::new()))
            .collect();
        cases.push((too_many, "environment"));
        let mut too_large = spec("/bin/sh");
        too_large.env.insert("BIG".into(), "x".repeat(16 * 1024));
        cases.push((too_large, "environment"));
        let mut bad_stdin = spec("/bin/sh");
        bad_stdin.stdin_base64 = "not base64!".into();
        cases.push((bad_stdin, "base64"));
        let mut long_stdin = spec("/bin/sh");
        long_stdin.stdin_base64 = base64::engine::general_purpose::STANDARD.encode("12345");
        cases.push((long_stdin, "input limit"));
        cases.push((spec("/definitely/missing/command"), "does not exist"));
        cases.push((spec("/bin"), "does not exist"));
        for (spec, expected) in cases {
            let message = rejection(&spec);
            assert!(message.contains(expected), "{expected}: {message}");
        }
    }

    #[test]
    fn resolves_command_symlinks_inside_the_runtime_root() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("usr/bin")).unwrap();
        fs::create_dir(root.path().join("bin")).unwrap();
        fs::write(root.path().join("usr/bin/tool"), b"").unwrap();
        symlink("/usr/bin/tool", root.path().join("bin/tool")).unwrap();
        // Exists on the host but not inside the runtime root.
        symlink("/bin/sh", root.path().join("bin/host-shell")).unwrap();
        symlink("../../../../../../bin/sh", root.path().join("bin/climb")).unwrap();

        assert!(is_runtime_file(root.path(), "/bin/tool"));
        assert!(!is_runtime_file(root.path(), "/bin/host-shell"));
        assert!(!is_runtime_file(root.path(), "/bin/climb"));
        assert!(!is_runtime_file(root.path(), "/usr/bin"));
    }
}
