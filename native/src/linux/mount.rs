use crate::error::SandboxError;
use crate::linux::paths::resolve_runtime_directory;
use std::ffi::CString;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

const RUNTIME_DIRS: [&str; 5] = ["bin", "sbin", "usr", "lib", "lib64"];
const SAFE_DEVICES: [&str; 4] = ["null", "zero", "random", "urandom"];
const AT_RECURSIVE: libc::c_uint = 0x8000;
const MOUNT_ATTR_RDONLY: u64 = 0x0000_0001;
const MOUNT_ATTR_NOSUID: u64 = 0x0000_0002;
const MOUNT_ATTR_NODEV: u64 = 0x0000_0004;

#[repr(C)]
struct MountAttr {
    attr_set: u64,
    attr_clr: u64,
    propagation: u64,
    userns_fd: u64,
}

pub fn build_root(source_root: &Path, new_root: &Path) -> Result<(), SandboxError> {
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

fn mount_safe_devices(new_root: &Path) -> Result<(), SandboxError> {
    for name in SAFE_DEVICES {
        let source = Path::new("/dev").join(name);
        let target = new_root.join("dev").join(name);
        fs::File::create(&target)?;
        mount(Some(&source), &target, None, libc::MS_BIND, None)?;
        mount(
            None,
            &target,
            None,
            libc::MS_BIND | libc::MS_REMOUNT | libc::MS_NOSUID | libc::MS_NOEXEC,
            None,
        )?;
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
        return Err(operation_error("mount_setattr"));
    }
    Ok(())
}

fn pivot_root(new_root: &Path) -> Result<(), SandboxError> {
    let new_root_c = path_cstring(new_root)?;
    // SAFETY: new_root names a mounted directory created by this process.
    if unsafe { libc::chdir(new_root_c.as_ptr()) } == -1 {
        return Err(operation_error("chdir new root"));
    }
    let dot = CString::new(".").expect("literal has no NUL");
    let old = CString::new(".old_root").expect("literal has no NUL");
    // SAFETY: both paths are directories beneath the new root mount.
    if unsafe { libc::syscall(libc::SYS_pivot_root, dot.as_ptr(), old.as_ptr()) } == -1 {
        return Err(operation_error("pivot_root"));
    }
    let slash = CString::new("/").expect("literal has no NUL");
    // SAFETY: slash is a valid directory after pivot_root.
    if unsafe { libc::chdir(slash.as_ptr()) } == -1 {
        return Err(operation_error("chdir /"));
    }
    // SAFETY: /.old_root is the detached previous root mount.
    if unsafe { libc::umount2(old_root().as_ptr(), libc::MNT_DETACH) } == -1 {
        return Err(operation_error("unmount old root"));
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
        return Err(operation_error(&format!(
            "mount {}",
            target.to_string_lossy()
        )));
    }
    Ok(())
}

fn path_cstring(path: &Path) -> Result<CString, SandboxError> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| SandboxError::PolicyViolation("path contains NUL".into()))
}

fn old_root() -> CString {
    CString::new("/.old_root").expect("literal has no NUL")
}

fn operation_error(operation: &str) -> SandboxError {
    SandboxError::Security(format!("{operation}: {}", io::Error::last_os_error()))
}

pub fn create_staging_root(job_id: &str) -> Result<PathBuf, SandboxError> {
    let path = PathBuf::from(format!(
        "/tmp/micro-sandbox-{job_id}-{}",
        std::process::id()
    ));
    fs::create_dir(&path)?;
    Ok(path)
}
