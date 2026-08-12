use crate::error::SandboxError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

const MAX_ARTIFACT_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ARTIFACT_FILES: u64 = 1024;
const MAX_ARTIFACT_ENTRIES: u64 = 4096;
const MAX_ARTIFACT_DEPTH: usize = 32;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArtifactLimits {
    pub input_files: u64,
    pub input_bytes: u64,
    pub input_file_bytes: u64,
    pub output_files: u64,
    pub output_bytes: u64,
    pub output_file_bytes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSpec {
    pub path: PathBuf,
    pub limits: ArtifactLimits,
    #[serde(default)]
    pub outputs: Vec<DeclaredOutput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeclaredOutput {
    pub path: String,
    pub max_bytes: Option<u64>,
    #[serde(default = "required_by_default")]
    pub required: bool,
}

#[derive(Debug, Serialize)]
pub struct ArtifactManifestEntry {
    path: String,
    size: u64,
    sha256: String,
}

pub struct ValidatedWorkspace {
    pub input: PathBuf,
    pub output: PathBuf,
    pub outputs: Vec<ValidatedOutput>,
}

pub struct ValidatedOutput {
    pub relative: PathBuf,
    pub host: PathBuf,
    pub handle: File,
    pub max_bytes: u64,
    pub required: bool,
}

pub fn validate_workspace(spec: &WorkspaceSpec) -> Result<ValidatedWorkspace, SandboxError> {
    validate_limits(spec.limits)?;
    let configured_root = std::env::var_os("MICRO_SANDBOX_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .ok_or_else(|| SandboxError::PolicyViolation("workspace root is not configured".into()))?;
    let root = fs::canonicalize(configured_root)?;
    validate_private_directory(&root, "workspace root")?;
    let workspace_metadata = fs::symlink_metadata(&spec.path)?;
    if !workspace_metadata.is_dir() || workspace_metadata.file_type().is_symlink() {
        return Err(SandboxError::PolicyViolation(
            "workspace must be a real directory".into(),
        ));
    }
    let workspace = fs::canonicalize(&spec.path)?;
    if workspace.parent() != Some(root.as_path()) {
        return Err(SandboxError::PolicyViolation(
            "workspace escapes its configured root".into(),
        ));
    }
    let input = contained_directory(&workspace, "input")?;
    let output = contained_directory(&workspace, "output")?;
    validate_private_directory(&workspace, "workspace")?;
    inspect_tree(
        &input,
        spec.limits.input_files,
        spec.limits.input_bytes,
        spec.limits.input_file_bytes,
        false,
    )?;
    let outputs = validate_declared_outputs(&output, &spec.outputs, spec.limits)?;
    Ok(ValidatedWorkspace {
        input,
        output,
        outputs,
    })
}

pub fn collect_outputs(
    workspace: &ValidatedWorkspace,
    limits: ArtifactLimits,
) -> Result<Vec<ArtifactManifestEntry>, SandboxError> {
    inspect_tree(
        &workspace.output,
        limits.output_files,
        limits.output_bytes,
        limits.output_file_bytes,
        false,
    )?;
    let mut manifest = Vec::with_capacity(workspace.outputs.len());
    for output in &workspace.outputs {
        let relative = output
            .relative
            .to_str()
            .ok_or_else(|| SandboxError::PolicyViolation("artifact path is not UTF-8".into()))?
            .to_owned();
        if relative.contains('\\') {
            return Err(SandboxError::PolicyViolation(
                "artifact paths may not contain backslashes".into(),
            ));
        }
        let mut file = output.handle.try_clone().map_err(|error| {
            SandboxError::Security(format!("clone pinned artifact output: {error}"))
        })?;
        let metadata = file.metadata().map_err(|error| {
            SandboxError::Security(format!("stat pinned artifact output: {error}"))
        })?;
        if metadata.len() == 0 && !output.required {
            continue;
        }
        if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > output.max_bytes {
            return Err(SandboxError::Security(
                "artifact changed after validation".into(),
            ));
        }
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let read = file.read(&mut buffer).map_err(|error| {
                SandboxError::Security(format!("read pinned artifact output: {error}"))
            })?;
            if read == 0 {
                break;
            }
            hash.update(&buffer[..read]);
        }
        manifest.push(ArtifactManifestEntry {
            path: relative,
            size: metadata.len(),
            sha256: format!("{:x}", hash.finalize()),
        });
    }
    manifest.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(manifest)
}

fn validate_declared_outputs(
    root: &Path,
    declared: &[DeclaredOutput],
    limits: ArtifactLimits,
) -> Result<Vec<ValidatedOutput>, SandboxError> {
    if declared.len() as u64 > limits.output_files {
        return Err(SandboxError::PolicyViolation(
            "declared artifact output count is invalid".into(),
        ));
    }
    let mut outputs = Vec::with_capacity(declared.len());
    let mut declared_bytes = 0_u64;
    let mut uniform_max = None;
    for item in declared {
        let relative = Path::new(&item.path);
        if item.path.is_empty()
            || item.path.len() > 1024
            || item.path.contains('\\')
            || relative.is_absolute()
            || relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err(SandboxError::PolicyViolation(
                "declared artifact output path is invalid".into(),
            ));
        }
        let max_bytes = item.max_bytes.unwrap_or(limits.output_file_bytes);
        match uniform_max {
            None => uniform_max = Some(max_bytes),
            Some(expected) if expected != max_bytes => {
                return Err(SandboxError::PolicyViolation(
                    "declared outputs must use one uniform hard maximum".into(),
                ));
            }
            Some(_) => {}
        }
        declared_bytes = declared_bytes.checked_add(max_bytes).ok_or_else(|| {
            SandboxError::PolicyViolation("artifact output byte count overflowed".into())
        })?;
        if max_bytes == 0
            || max_bytes > limits.output_file_bytes
            || declared_bytes > limits.output_bytes
        {
            return Err(SandboxError::PolicyViolation(
                "declared outputs exceed their limits".into(),
            ));
        }
        let host = root.join(relative);
        let metadata = fs::symlink_metadata(&host)?;
        let canonical = fs::canonicalize(&host)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.nlink() != 1
            || metadata.len() != 0
            || !canonical.starts_with(root)
            || outputs
                .iter()
                .any(|existing: &ValidatedOutput| existing.relative == relative)
        {
            return Err(SandboxError::PolicyViolation(
                "declared artifact output is unsafe".into(),
            ));
        }
        outputs.push(ValidatedOutput {
            relative: relative.to_path_buf(),
            host: canonical,
            handle: open_path(&host, libc::O_RDWR)?,
            max_bytes,
            required: item.required,
        });
    }
    let files = inspect_tree(root, limits.output_files, 0, 0, true)?;
    if files.len() != outputs.len() {
        return Err(SandboxError::PolicyViolation(
            "artifact output tree contains undeclared files".into(),
        ));
    }
    Ok(outputs)
}

const fn required_by_default() -> bool {
    true
}

pub fn validate_outputs(
    workspace: &ValidatedWorkspace,
    limits: ArtifactLimits,
) -> Result<(), SandboxError> {
    inspect_tree(
        &workspace.output,
        limits.output_files,
        limits.output_bytes,
        limits.output_file_bytes,
        false,
    )?;
    Ok(())
}

pub fn available_bytes(path: &Path) -> Result<u64, SandboxError> {
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| SandboxError::PolicyViolation("workspace path contains NUL".into()))?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: path is NUL-terminated and stats points to writable storage.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } == -1 {
        return Err(SandboxError::Io(std::io::Error::last_os_error()));
    }
    // SAFETY: statvfs initialized stats after returning success.
    let stats = unsafe { stats.assume_init() };
    Ok(stats.f_bavail.saturating_mul(stats.f_frsize))
}

fn validate_limits(limits: ArtifactLimits) -> Result<(), SandboxError> {
    if limits.input_files == 0
        || limits.output_files == 0
        || limits.input_files > MAX_ARTIFACT_FILES
        || limits.output_files > MAX_ARTIFACT_FILES
        || limits.input_bytes == 0
        || limits.input_file_bytes == 0
        || limits.output_bytes == 0
        || limits.output_file_bytes == 0
        || limits.input_bytes > MAX_ARTIFACT_BYTES
        || limits.input_file_bytes > limits.input_bytes
        || limits.output_bytes > MAX_ARTIFACT_BYTES
        || limits.output_file_bytes > limits.output_bytes
    {
        return Err(SandboxError::PolicyViolation(
            "artifact limits exceed immutable native bounds".into(),
        ));
    }
    Ok(())
}

fn contained_directory(root: &Path, name: &str) -> Result<PathBuf, SandboxError> {
    let candidate = root.join(name);
    let metadata = fs::symlink_metadata(&candidate)?;
    let resolved = fs::canonicalize(candidate)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || !resolved.starts_with(root) {
        return Err(SandboxError::PolicyViolation(format!(
            "workspace {name} directory is unsafe"
        )));
    }
    Ok(resolved)
}

fn open_path(path: &Path, flags: libc::c_int) -> Result<File, SandboxError> {
    OpenOptions::new()
        .read(true)
        .write(flags & libc::O_RDWR != 0)
        .custom_flags(flags | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(SandboxError::Io)
}

fn validate_private_directory(path: &Path, label: &str) -> Result<(), SandboxError> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = fs::metadata(path)?;
    // SAFETY: geteuid has no preconditions.
    let effective_uid = unsafe { libc::geteuid() };
    if metadata.uid() != effective_uid || metadata.permissions().mode() & 0o022 != 0 {
        return Err(SandboxError::PolicyViolation(format!(
            "{label} must be owned by the supervisor user and not group/world writable"
        )));
    }
    Ok(())
}

fn inspect_tree(
    root: &Path,
    max_files: u64,
    max_bytes: u64,
    max_file_bytes: u64,
    require_empty: bool,
) -> Result<Vec<(PathBuf, u64)>, SandboxError> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut total = 0_u64;
    let mut allocated = 0_u64;
    let mut allocation_overhead = 0_u64;
    let mut entries = 0_u64;
    let max_entries = max_files.saturating_mul(4).clamp(64, MAX_ARTIFACT_ENTRIES);
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|error| {
            SandboxError::Security(format!(
                "read artifact directory {}: {error}",
                directory.display()
            ))
        })? {
            let entry = entry.map_err(|error| {
                SandboxError::Security(format!("read artifact directory entry: {error}"))
            })?;
            entries = entries.saturating_add(1);
            if entries > max_entries {
                return Err(SandboxError::PolicyViolation(
                    "artifact tree contains too many entries".into(),
                ));
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
                SandboxError::Security(format!("stat artifact tree entry: {error}"))
            })?;
            if metadata.file_type().is_symlink() {
                return Err(SandboxError::PolicyViolation(
                    "artifact trees may not contain symbolic links".into(),
                ));
            }
            if metadata.is_dir() {
                let depth = entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|_| SandboxError::Security("artifact escaped its root".into()))?
                    .components()
                    .count();
                if depth > MAX_ARTIFACT_DEPTH {
                    return Err(SandboxError::PolicyViolation(
                        "artifact tree is nested too deeply".into(),
                    ));
                }
                pending.push(entry.path());
                continue;
            }
            if !metadata.is_file() || metadata.nlink() != 1 {
                return Err(SandboxError::PolicyViolation(
                    "artifact trees may contain only regular unlinked files".into(),
                ));
            }
            let size = metadata.len();
            if require_empty && size != 0 {
                return Err(SandboxError::PolicyViolation(
                    "declared artifact outputs must start empty".into(),
                ));
            }
            total = total.checked_add(size).ok_or_else(|| {
                SandboxError::PolicyViolation("artifact byte count overflowed".into())
            })?;
            allocated = allocated
                .checked_add(metadata.blocks().saturating_mul(512))
                .ok_or_else(|| {
                    SandboxError::PolicyViolation("artifact allocation count overflowed".into())
                })?;
            allocation_overhead = allocation_overhead
                .max(max_files.saturating_mul(metadata.blksize().saturating_sub(1)));
            files.push((entry.path(), size));
            if files.len() as u64 > max_files
                || total > max_bytes
                || allocated > max_bytes.saturating_add(allocation_overhead)
                || size > max_file_bytes
            {
                return Err(SandboxError::PolicyViolation(
                    "artifact tree exceeds its configured limits".into(),
                ));
            }
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn limits() -> ArtifactLimits {
        ArtifactLimits {
            input_files: 2,
            input_bytes: 1024,
            input_file_bytes: 1024,
            output_files: 2,
            output_bytes: 1024,
            output_file_bytes: 1024,
        }
    }

    fn workspace(root: &Path, output: PathBuf, declared: Option<&str>) -> ValidatedWorkspace {
        let outputs = declared.map_or_else(Vec::new, |name| {
            let host = output.join(name);
            vec![ValidatedOutput {
                relative: PathBuf::from(name),
                handle: open_path(&host, libc::O_RDWR).unwrap(),
                host,
                max_bytes: 1024,
                required: true,
            }]
        });
        ValidatedWorkspace {
            input: root.to_path_buf(),
            output,
            outputs,
        }
    }

    #[test]
    fn collects_only_single_link_regular_files() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output");
        fs::create_dir(&output).unwrap();
        fs::write(output.join("safe.bin"), b"safe").unwrap();
        let workspace = workspace(root.path(), output, Some("safe.bin"));
        let manifest = collect_outputs(&workspace, limits()).unwrap();
        assert_eq!(manifest.len(), 1);
        assert_eq!(manifest[0].path, "safe.bin");
        assert_eq!(manifest[0].size, 4);
    }

    #[test]
    fn rejects_symbolic_link_outputs() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("output");
        fs::create_dir(&output).unwrap();
        symlink("/etc/passwd", output.join("leak")).unwrap();
        let workspace = workspace(root.path(), output, None);
        assert!(collect_outputs(&workspace, limits()).is_err());
    }
}
