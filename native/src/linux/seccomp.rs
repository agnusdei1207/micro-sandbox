use crate::error::SandboxError;
use crate::linux::os_error;

const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JMP_JEQ_K: u16 = 0x15;
const BPF_JMP_JSET_K: u16 = 0x45;
const BPF_ALU_AND_K: u16 = 0x54;
#[cfg(target_arch = "x86_64")]
const BPF_JMP_JGE_K: u16 = 0x35;
const BPF_RET_K: u16 = 0x06;
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const SECCOMP_MODE_FILTER: libc::c_ulong = 2;

/// Offsets into `struct seccomp_data`.
const DATA_NR: u32 = 0;
const DATA_ARCH: u32 = 4;
/// Low 32 bits of the first and second syscall arguments (little-endian targets).
const DATA_ARG0: u32 = 16;
const DATA_ARG1: u32 = 24;

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xc000_003e;
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xc000_00b7;

/// `kexec_file_load` is not exported by the musl aarch64 libc bindings.
#[cfg(target_arch = "x86_64")]
pub const SYS_KEXEC_FILE_LOAD: libc::c_long = 320;
#[cfg(target_arch = "aarch64")]
pub const SYS_KEXEC_FILE_LOAD: libc::c_long = 294;
/// `open_tree_attr` (Linux 6.15) uses the unified syscall table shared by all
/// supported architectures since syscall 424.
pub const SYS_OPEN_TREE_ATTR: libc::c_long = 467;

/// Regular-file preallocation ioctls (`XFS_IOC_RESVSP`, `XFS_IOC_RESVSP64`,
/// `XFS_IOC_ZERO_RANGE`) reach `vfs_fallocate` and can bypass `RLIMIT_FSIZE`.
pub const PREALLOCATION_IOCTLS: [u32; 3] = [0x5828, 0x582a, 0x5839];

pub fn apply_baseline() -> Result<(), SandboxError> {
    // SAFETY: PR_SET_NO_NEW_PRIVS with value 1 and zero trailing arguments is documented.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } == -1 {
        return Err(os_error("PR_SET_NO_NEW_PRIVS"));
    }

    let mut filter = baseline_filter();
    let program = libc::sock_fprog {
        len: u16::try_from(filter.len())
            .map_err(|_| SandboxError::Security("seccomp filter is too large".into()))?,
        filter: filter.as_mut_ptr(),
    };
    // SAFETY: program references `filter`, which remains alive for the duration of prctl.
    if unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            SECCOMP_MODE_FILTER,
            &program as *const libc::sock_fprog,
            0,
            0,
        )
    } == -1
    {
        return Err(os_error("PR_SET_SECCOMP"));
    }
    Ok(())
}

/// Exercises the installed baseline filter with harmless invalid arguments and reports,
/// per probe, whether the kernel returned the filter's expected result.
///
/// Every argument set is invalid, so an unfiltered kernel fails with a different errno
/// (EBADF, EINVAL, EFAULT, ...) instead of performing the operation.
pub fn probe_baseline() -> Vec<(&'static str, bool)> {
    fn returns(result: libc::c_long, errno: i32) -> bool {
        result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(errno)
    }
    let null = std::ptr::null::<libc::c_void>();
    let mut probes = Vec::new();
    // SAFETY (all syscalls below): seccomp rejects them before arguments are inspected;
    // without the filter, the invalid descriptors, null pointers, or contradictory flags
    // make the kernel fail before dereferencing anything or changing process state.
    unsafe {
        probes.push((
            "fspick",
            returns(libc::syscall(libc::SYS_fspick, -1, null, 0), libc::EPERM),
        ));
        probes.push((
            "open_tree_attr",
            returns(
                libc::syscall(SYS_OPEN_TREE_ATTR, -1, null, 0, null, 0),
                libc::EPERM,
            ),
        ));
        probes.push((
            "kexec_file_load",
            returns(
                libc::syscall(SYS_KEXEC_FILE_LOAD, -1, -1, 0, null, 0),
                libc::EPERM,
            ),
        ));
        probes.push((
            "quotactl_fd",
            returns(
                libc::syscall(libc::SYS_quotactl_fd, -1, 0, 0, null),
                libc::EPERM,
            ),
        ));
        for (name, syscall) in [
            ("process_vm_readv", libc::SYS_process_vm_readv),
            ("process_vm_writev", libc::SYS_process_vm_writev),
        ] {
            probes.push((
                name,
                returns(libc::syscall(syscall, 0, null, 1, null, 1, 0), libc::EPERM),
            ));
        }
        probes.push((
            "pidfd_getfd",
            returns(libc::syscall(libc::SYS_pidfd_getfd, -1, 0, 0), libc::EPERM),
        ));
        probes.push(("unshare", returns(libc::unshare(-1).into(), libc::EPERM)));
        probes.push(("setns", returns(libc::setns(-1, 0).into(), libc::EPERM)));
        // CLONE_THREAD without CLONE_SIGHAND is rejected with EINVAL if seccomp allows it.
        let legacy_clone = (libc::CLONE_NEWUSER | libc::CLONE_THREAD) as libc::c_long;
        probes.push((
            "clone_newuser",
            returns(
                libc::syscall(libc::SYS_clone, legacy_clone, 0, 0, 0, 0),
                libc::EPERM,
            ),
        ));
        probes.push((
            "clone3",
            returns(libc::syscall(libc::SYS_clone3, null, 0), libc::ENOSYS),
        ));
        for (name, command) in [
            ("ioctl_resvsp", PREALLOCATION_IOCTLS[0]),
            ("ioctl_resvsp64", PREALLOCATION_IOCTLS[1]),
            ("ioctl_zero_range", PREALLOCATION_IOCTLS[2]),
        ] {
            probes.push((
                name,
                returns(
                    libc::syscall(libc::SYS_ioctl, -1, command as libc::c_ulong, 0),
                    libc::EPERM,
                ),
            ));
        }
        // An ordinary ioctl still reaches the kernel, which rejects the bad descriptor.
        probes.push((
            "ioctl_fionread_allowed",
            returns(
                libc::syscall(libc::SYS_ioctl, -1, libc::FIONREAD, 0),
                libc::EBADF,
            ),
        ));
    }
    probes
}

fn baseline_filter() -> Vec<libc::sock_filter> {
    let mut filter = vec![
        statement(BPF_LD_W_ABS, DATA_ARCH),
        jump(BPF_JMP_JEQ_K, AUDIT_ARCH, 1, 0),
        statement(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
        statement(BPF_LD_W_ABS, DATA_NR),
    ];

    #[cfg(target_arch = "x86_64")]
    {
        // Reject the x32 ABI, whose syscall numbers would bypass the table below.
        filter.push(jump(BPF_JMP_JGE_K, 0x4000_0000, 0, 1));
        filter.push(statement(BPF_RET_K, SECCOMP_RET_KILL_PROCESS));
    }

    for &syscall in denied_syscalls() {
        filter.extend(syscall_block(syscall, vec![deny(libc::EPERM)]));
    }
    // Match ioctl type+number while retaining ordinary runtime ioctls.
    let mut ioctl = vec![
        statement(BPF_LD_W_ABS, DATA_ARG1),
        statement(BPF_ALU_AND_K, 0xffff),
    ];
    for command in PREALLOCATION_IOCTLS {
        ioctl.extend(deny_if_equal(command));
    }
    ioctl.push(statement(BPF_LD_W_ABS, DATA_NR));
    filter.extend(syscall_block(libc::SYS_ioctl, ioctl));
    // The guest must not disable the launcher-death kill signal.
    let mut prctl = vec![statement(BPF_LD_W_ABS, DATA_ARG0)];
    prctl.extend(deny_if_equal(libc::PR_SET_PDEATHSIG as u32));
    prctl.push(statement(BPF_LD_W_ABS, DATA_NR));
    filter.extend(syscall_block(libc::SYS_prctl, prctl));
    // clone3 stores flags behind a pointer that classic seccomp BPF cannot inspect.
    // ENOSYS lets libc safely fall back to legacy clone for ordinary threads/processes.
    filter.extend(syscall_block(libc::SYS_clone3, vec![deny(libc::ENOSYS)]));
    // Legacy clone may create processes, but may not create or join namespaces.
    filter.extend(syscall_block(
        libc::SYS_clone,
        vec![
            statement(BPF_LD_W_ABS, DATA_ARG0),
            jump(BPF_JMP_JSET_K, namespace_clone_flags(), 0, 1),
            deny(libc::EPERM),
            statement(BPF_LD_W_ABS, DATA_NR),
        ],
    ));
    filter.push(statement(BPF_RET_K, SECCOMP_RET_ALLOW));
    filter
}

fn denied_syscalls() -> &'static [libc::c_long] {
    &[
        libc::SYS_mount,
        libc::SYS_mount_setattr,
        libc::SYS_fsopen,
        libc::SYS_fsconfig,
        libc::SYS_fsmount,
        libc::SYS_fspick,
        libc::SYS_move_mount,
        libc::SYS_open_tree,
        SYS_OPEN_TREE_ATTR,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_ptrace,
        libc::SYS_process_vm_readv,
        libc::SYS_process_vm_writev,
        libc::SYS_pidfd_getfd,
        libc::SYS_bpf,
        libc::SYS_keyctl,
        libc::SYS_add_key,
        libc::SYS_request_key,
        libc::SYS_perf_event_open,
        libc::SYS_userfaultfd,
        libc::SYS_open_by_handle_at,
        libc::SYS_init_module,
        libc::SYS_finit_module,
        libc::SYS_delete_module,
        libc::SYS_reboot,
        libc::SYS_swapon,
        libc::SYS_swapoff,
        libc::SYS_kexec_load,
        SYS_KEXEC_FILE_LOAD,
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_seccomp,
        libc::SYS_acct,
        libc::SYS_quotactl,
        libc::SYS_quotactl_fd,
        libc::SYS_fallocate,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
    ]
}

/// Namespace flags checked on legacy `clone`.
///
/// `CLONE_NEWTIME` (0x80) is deliberately absent: legacy `clone` uses the low byte
/// (`CSIGNAL`) as the exit signal, so that bit cannot express a time namespace there.
/// Time namespaces remain unreachable because `unshare`, `setns`, and `clone3` are blocked.
const fn namespace_clone_flags() -> u32 {
    (libc::CLONE_NEWCGROUP
        | libc::CLONE_NEWIPC
        | libc::CLONE_NEWNET
        | libc::CLONE_NEWNS
        | libc::CLONE_NEWPID
        | libc::CLONE_NEWUSER
        | libc::CLONE_NEWUTS) as u32
}

/// Runs `body` only for `syscall`; otherwise jumps past it with the syscall number
/// still loaded. The body must return or reload the syscall number before it ends.
fn syscall_block(syscall: libc::c_long, body: Vec<libc::sock_filter>) -> Vec<libc::sock_filter> {
    let skip = u8::try_from(body.len()).expect("seccomp block exceeds the BPF jump range");
    let mut block = Vec::with_capacity(body.len() + 1);
    block.push(jump(BPF_JMP_JEQ_K, syscall as u32, 0, skip));
    block.extend(body);
    block
}

fn deny_if_equal(value: u32) -> [libc::sock_filter; 2] {
    [jump(BPF_JMP_JEQ_K, value, 0, 1), deny(libc::EPERM)]
}

const fn deny(errno: i32) -> libc::sock_filter {
    statement(BPF_RET_K, SECCOMP_RET_ERRNO | errno as u32)
}

const fn statement(code: u16, value: u32) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt: 0,
        jf: 0,
        k: value,
    }
}

const fn jump(code: u16, value: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt,
        jf,
        k: value,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALLOW: u32 = SECCOMP_RET_ALLOW;
    const EPERM: u32 = SECCOMP_RET_ERRNO | libc::EPERM as u32;
    const ENOSYS: u32 = SECCOMP_RET_ERRNO | libc::ENOSYS as u32;

    /// Minimal classic-BPF interpreter covering the instructions the filter emits.
    fn evaluate(arch: u32, syscall: libc::c_long, args: [u64; 6]) -> u32 {
        let mut data = [0_u8; 64];
        data[0..4].copy_from_slice(&(syscall as u32).to_le_bytes());
        data[4..8].copy_from_slice(&arch.to_le_bytes());
        for (index, value) in args.iter().enumerate() {
            let offset = 16 + index * 8;
            data[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        }
        let filter = baseline_filter();
        let mut accumulator = 0_u32;
        let mut pc = 0;
        loop {
            let instruction = filter[pc];
            pc += 1;
            let k = instruction.k;
            let branch = |taken: bool| {
                usize::from(if taken {
                    instruction.jt
                } else {
                    instruction.jf
                })
            };
            match instruction.code {
                BPF_LD_W_ABS => {
                    let offset = k as usize;
                    accumulator = u32::from_le_bytes(data[offset..offset + 4].try_into().unwrap());
                }
                BPF_ALU_AND_K => accumulator &= k,
                BPF_JMP_JEQ_K => pc += branch(accumulator == k),
                BPF_JMP_JSET_K => pc += branch(accumulator & k != 0),
                #[cfg(target_arch = "x86_64")]
                BPF_JMP_JGE_K => pc += branch(accumulator >= k),
                BPF_RET_K => return k,
                code => panic!("unexpected BPF instruction {code:#x}"),
            }
        }
    }

    fn call(syscall: libc::c_long, args: [u64; 6]) -> u32 {
        evaluate(AUDIT_ARCH, syscall, args)
    }

    #[test]
    fn kills_foreign_architectures() {
        assert_eq!(
            evaluate(0x4000_0003, libc::SYS_read, [0; 6]),
            SECCOMP_RET_KILL_PROCESS
        );
        #[cfg(target_arch = "x86_64")]
        assert_eq!(call(0x4000_0000, [0; 6]), SECCOMP_RET_KILL_PROCESS);
    }

    #[test]
    fn denies_every_listed_syscall_and_allows_ordinary_ones() {
        for &syscall in denied_syscalls() {
            assert_eq!(call(syscall, [0; 6]), EPERM, "syscall {syscall}");
        }
        for syscall in [
            libc::SYS_read,
            libc::SYS_write,
            libc::SYS_execve,
            libc::SYS_wait4,
        ] {
            assert_eq!(call(syscall, [0; 6]), ALLOW, "syscall {syscall}");
        }
    }

    #[test]
    fn filters_preallocation_ioctls_by_type_and_number() {
        for command in PREALLOCATION_IOCTLS {
            assert_eq!(
                call(libc::SYS_ioctl, [3, u64::from(command), 0, 0, 0, 0]),
                EPERM
            );
            // Direction and size bits do not hide the command.
            let encoded = 0xc020_0000 | u64::from(command);
            assert_eq!(call(libc::SYS_ioctl, [3, encoded, 0, 0, 0, 0]), EPERM);
        }
        assert_eq!(call(libc::SYS_ioctl, [1, 0x5401, 0, 0, 0, 0]), ALLOW);
        assert_eq!(
            call(libc::SYS_ioctl, [1, libc::FIONREAD, 0, 0, 0, 0]),
            ALLOW
        );
    }

    #[test]
    fn only_blocks_the_parent_death_signal_prctl() {
        let set = libc::PR_SET_PDEATHSIG as u64;
        assert_eq!(call(libc::SYS_prctl, [set, 0, 0, 0, 0, 0]), EPERM);
        assert_eq!(
            call(libc::SYS_prctl, [libc::PR_SET_NAME as u64, 0, 0, 0, 0, 0]),
            ALLOW
        );
        assert_eq!(
            call(
                libc::SYS_prctl,
                [libc::PR_GET_PDEATHSIG as u64, 0, 0, 0, 0, 0]
            ),
            ALLOW
        );
    }

    #[test]
    fn restricts_clone_namespaces_and_clone3() {
        let sigchld = libc::SIGCHLD as u64;
        assert_eq!(call(libc::SYS_clone, [sigchld, 0, 0, 0, 0, 0]), ALLOW);
        let thread = (libc::CLONE_VM
            | libc::CLONE_FS
            | libc::CLONE_FILES
            | libc::CLONE_SIGHAND
            | libc::CLONE_THREAD
            | libc::CLONE_SYSVSEM
            | libc::CLONE_SETTLS
            | libc::CLONE_PARENT_SETTID
            | libc::CLONE_CHILD_CLEARTID) as u64;
        assert_eq!(call(libc::SYS_clone, [thread, 0, 0, 0, 0, 0]), ALLOW);
        for namespace in [
            libc::CLONE_NEWUSER,
            libc::CLONE_NEWNS,
            libc::CLONE_NEWPID,
            libc::CLONE_NEWNET,
            libc::CLONE_NEWIPC,
            libc::CLONE_NEWUTS,
            libc::CLONE_NEWCGROUP,
        ] {
            let flags = namespace as u64 | sigchld;
            assert_eq!(call(libc::SYS_clone, [flags, 0, 0, 0, 0, 0]), EPERM);
        }
        // The exit-signal byte is not interpreted as a namespace flag.
        assert_eq!(
            call(libc::SYS_clone, [0x80 | sigchld, 0, 0, 0, 0, 0]),
            ALLOW
        );
        assert_eq!(call(libc::SYS_clone3, [0; 6]), ENOSYS);
    }
}
