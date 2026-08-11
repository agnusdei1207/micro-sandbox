use crate::error::SandboxError;
use std::fs;
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
