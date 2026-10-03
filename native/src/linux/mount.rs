use crate::artifact::ValidatedWorkspace;
use crate::error::SandboxError;
use crate::linux::os_error;
use crate::linux::paths::{path_cstring, resolve_runtime_directory};
use std::ffi::{CString, OsString};
use std::fs;
use std::io;
use std::os::unix::ffi::OsStringExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};

const RUNTIME_DIRS: [&str; 5] = ["bin", "sbin", "usr", "lib", "lib64"];
const SAFE_DEVICES: [&str; 4] = ["null", "zero", "random", "urandom"];
const AT_RECURSIVE: libc::c_uint = 0x8000;
const MOUNT_ATTR_RDONLY: u64 = 0x0000_0001;
const MOUNT_ATTR_NOSUID: u64 = 0x0000_0002;
const MOUNT_ATTR_NODEV: u64 = 0x0000_0004;
const MOUNT_ATTR_NOEXEC: u64 = 0x0000_0008;

#[repr(C)]
struct MountAttr {
    attr_set: u64,
    attr_clr: u64,
    propagation: u64,
    userns_fd: u64,
}

pub fn build_root(
    source_root: &Path,
    new_root: &Path,
    workspace: Option<&ValidatedWorkspace>,
) -> Result<(), SandboxError> {
    mount(
        None,
        Path::new("/"),
        None,
        libc::MS_REC | libc::MS_PRIVATE,
        None,
    )?;
    mount(
        Some(Path::new("tmpfs")),
        new_root,
        Some("tmpfs"),
        libc::MS_NOSUID | libc::MS_NODEV,
        Some("mode=0755,size=16m"),
    )?;

    for relative in RUNTIME_DIRS {
        let source = source_root.join(relative);
        if source.exists() {
            let source = resolve_runtime_directory(source_root, relative)?;
            bind_read_only(&source, &new_root.join(relative))?;
        }
    }

    fs::create_dir_all(new_root.join("proc"))?;
    fs::create_dir_all(new_root.join("tmp"))?;
    fs::create_dir_all(new_root.join("dev"))?;
    fs::create_dir_all(new_root.join(".old_root"))?;
    if let Some(workspace) = workspace {
        bind_artifacts(workspace, new_root)?;
    }
    mount_safe_devices(new_root)?;
    mount(
        Some(Path::new("tmpfs")),
        &new_root.join("tmp"),
        Some("tmpfs"),
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        Some("mode=1777,size=16m"),
    )?;
    mount(
        Some(Path::new("proc")),
        &new_root.join("proc"),
        Some("proc"),
        libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
        None,
    )?;

    pivot_root(new_root)
}

fn bind_artifacts(workspace: &ValidatedWorkspace, new_root: &Path) -> Result<(), SandboxError> {
    let input_target = new_root.join("input");
    let output_target = new_root.join("output");
    fs::create_dir_all(&input_target)?;
    mount(
        Some(&workspace.input),
        &input_target,
        None,
        libc::MS_BIND,
        None,
    )?;
    set_mount_attributes_recursive(
        &input_target,
        MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC,
    )?;
    fs::create_dir_all(&output_target)?;
    mount(
        Some(&workspace.output),
        &output_target,
        None,
        libc::MS_BIND,
        None,
    )?;
    set_mount_attributes_recursive(
        &output_target,
        MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC,
    )?;
    for declared in &workspace.outputs {
        let target = output_target.join(&declared.relative);
        // The pinned handle's mount belongs to the launcher's original mount namespace and
        // cannot be a bind source here, so bind the host path and then require that the
        // writable mount resolves to the validated inode.
        mount(Some(&declared.host), &target, None, libc::MS_BIND, None)?;
        let mounted = fs::metadata(&target)?;
        let pinned = declared.handle.metadata()?;
        if (mounted.dev(), mounted.ino()) != (pinned.dev(), pinned.ino()) {
            return Err(SandboxError::Security(
                "declared artifact output changed before it was mounted".into(),
            ));
        }
        set_mount_attributes_recursive(
            &target,
            MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV | MOUNT_ATTR_NOEXEC,
        )?;
    }
    Ok(())
}

fn mount_safe_devices(new_root: &Path) -> Result<(), SandboxError> {
    for name in SAFE_DEVICES {
        let source = Path::new("/dev").join(name);
        let target = new_root.join("dev").join(name);
        fs::File::create(&target)?;
        mount(Some(&source), &target, None, libc::MS_BIND, None)?;
        set_mount_attributes_recursive(&target, MOUNT_ATTR_NOSUID | MOUNT_ATTR_NOEXEC)?;
    }
    Ok(())
}

fn bind_read_only(source: &Path, target: &Path) -> Result<(), SandboxError> {
    fs::create_dir_all(target)?;
    mount(
        Some(source),
        target,
        None,
        libc::MS_BIND | libc::MS_REC,
        None,
    )?;
    set_mount_attributes_recursive(
        target,
        MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV,
    )
}

fn set_mount_attributes_recursive(target: &Path, attributes: u64) -> Result<(), SandboxError> {
    let target = path_cstring(target)?;
    let attr = MountAttr {
        attr_set: attributes,
        attr_clr: 0,
        propagation: 0,
        userns_fd: 0,
    };
    // SAFETY: target and attr are valid for mount_setattr; AT_RECURSIVE applies to submounts.
    let result = unsafe {
        libc::syscall(
            libc::SYS_mount_setattr,
            libc::AT_FDCWD,
            target.as_ptr(),
            AT_RECURSIVE,
            &attr as *const MountAttr,
            std::mem::size_of::<MountAttr>(),
        )
    };
    if result == -1 {
        return Err(os_error("mount_setattr"));
    }
    Ok(())
}

fn pivot_root(new_root: &Path) -> Result<(), SandboxError> {
    let new_root = path_cstring(new_root)?;
    // SAFETY: new_root names a mounted directory created by this process.
    if unsafe { libc::chdir(new_root.as_ptr()) } == -1 {
        return Err(os_error("chdir new root"));
    }
    // SAFETY: both paths are directories beneath the new root mount.
    if unsafe { libc::syscall(libc::SYS_pivot_root, c".".as_ptr(), c".old_root".as_ptr()) } == -1 {
        return Err(os_error("pivot_root"));
    }
    // SAFETY: "/" is a valid directory after pivot_root.
    if unsafe { libc::chdir(c"/".as_ptr()) } == -1 {
        return Err(os_error("chdir /"));
    }
    // SAFETY: /.old_root is the detached previous root mount.
    if unsafe { libc::umount2(c"/.old_root".as_ptr(), libc::MNT_DETACH) } == -1 {
        return Err(os_error("unmount old root"));
    }
    fs::remove_dir("/.old_root")?;
    Ok(())
}

fn mount(
    source: Option<&Path>,
    target: &Path,
    filesystem: Option<&str>,
    flags: libc::c_ulong,
    data: Option<&str>,
) -> Result<(), SandboxError> {
    let source = source.map(path_cstring).transpose()?;
    let target = path_cstring(target)?;
    let filesystem = filesystem
        .map(CString::new)
        .transpose()
        .map_err(|_| SandboxError::PolicyViolation("filesystem type contains NUL".into()))?;
    let data = data
        .map(CString::new)
        .transpose()
        .map_err(|_| SandboxError::PolicyViolation("mount data contains NUL".into()))?;
    // SAFETY: optional strings are NUL-terminated and target is a valid path.
    let result = unsafe {
        libc::mount(
            source
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
            target.as_ptr(),
            filesystem
                .as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr()),
            flags,
            data.as_ref()
                .map_or(std::ptr::null(), |value| value.as_ptr().cast()),
        )
    };
    if result == -1 {
        // Capture errno before formatting allocates.
        let error = io::Error::last_os_error();
        return Err(SandboxError::Security(format!(
            "mount {}: {error}",
            target.to_string_lossy()
        )));
    }
    Ok(())
}

/// Private per-user directory holding job staging roots.
///
/// The supervisor and its launchers share the environment, so both resolve the same path.
pub fn staging_base() -> PathBuf {
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    std::env::temp_dir().join(format!("micro-sandbox-{uid}"))
}

/// Creates an unpredictable, private, empty staging root for one job.
pub fn create_staging_root(job_id: &str) -> Result<PathBuf, SandboxError> {
    let base = staging_base();
    match fs::DirBuilder::new().mode(0o700).create(&base) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(SandboxError::Io(error)),
    }
    let metadata = fs::symlink_metadata(&base)?;
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
        return Err(SandboxError::Security(format!(
            "staging directory {} must be a private directory owned by the service user",
            base.display()
        )));
    }
    let mut template = path_cstring(&base.join(format!("{job_id}-XXXXXX")))?.into_bytes_with_nul();
    // SAFETY: template is a writable NUL-terminated buffer ending in XXXXXX.
    if unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) }.is_null() {
        return Err(os_error("mkdtemp staging root"));
    }
    template.pop();
    Ok(PathBuf::from(OsString::from_vec(template)))
}

/// Lists staging roots as `(job ID, path)` pairs.
pub fn staging_roots() -> io::Result<Vec<(String, PathBuf)>> {
    let entries = match fs::read_dir(staging_base()) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut roots = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        if let Some((job_id, _)) = name.to_str().and_then(|name| name.rsplit_once('-')) {
            roots.push((job_id.to_owned(), entry.path()));
        }
    }
    Ok(roots)
}

/// Removes every staging root left by `job_id`, e.g. after its launcher was killed.
pub fn remove_staging_roots(job_id: &str) -> io::Result<()> {
    for (owner, path) in staging_roots()? {
        if owner == job_id {
            remove_staging_root(&path)?;
        }
    }
    Ok(())
}

/// Removes one empty staging root; a missing directory counts as removed.
pub fn remove_staging_root(path: &Path) -> io::Result<()> {
    match fs::remove_dir(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}
