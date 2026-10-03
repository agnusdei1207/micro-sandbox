use crate::error::SandboxError;
use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

pub fn resolve_runtime_directory(
    runtime_root: &Path,
    relative: &str,
) -> Result<PathBuf, SandboxError> {
    let root = fs::canonicalize(runtime_root)?;
    let resolved = fs::canonicalize(root.join(relative))?;
    if !resolved.starts_with(&root) || !resolved.is_dir() {
        return Err(SandboxError::PolicyViolation(format!(
            "runtime directory {relative:?} escapes its root"
        )));
    }
    Ok(resolved)
}

/// Converts a host path into a NUL-terminated C string for a syscall.
pub fn path_cstring(path: &Path) -> Result<CString, SandboxError> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| SandboxError::PolicyViolation("path contains NUL".into()))
}
