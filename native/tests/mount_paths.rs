#![cfg(target_os = "linux")]

use micro_sandbox_native::linux::paths::resolve_runtime_directory;
use std::fs;
use std::os::unix::fs::symlink;
use tempfile::tempdir;

#[test]
fn accepts_internal_runtime_symlinks_and_rejects_external_ones() {
    let root = tempdir().unwrap();
    let outside = tempdir().unwrap();
    fs::create_dir_all(root.path().join("usr/bin")).unwrap();
    symlink("usr/bin", root.path().join("bin")).unwrap();
    symlink(outside.path(), root.path().join("lib")).unwrap();

    assert_eq!(
        resolve_runtime_directory(root.path(), "bin").unwrap(),
        fs::canonicalize(root.path().join("usr/bin")).unwrap(),
    );
    assert!(resolve_runtime_directory(root.path(), "lib").is_err());
}
