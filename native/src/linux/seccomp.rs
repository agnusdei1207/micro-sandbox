use crate::error::SandboxError;
use std::io;

const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JMP_JEQ_K: u16 = 0x15;
#[cfg(target_arch = "x86_64")]
const BPF_JMP_JGE_K: u16 = 0x35;
const BPF_RET_K: u16 = 0x06;
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const SECCOMP_MODE_FILTER: libc::c_ulong = 2;

#[cfg(target_arch = "x86_64")]
const AUDIT_ARCH: u32 = 0xc000_003e;
#[cfg(target_arch = "aarch64")]
const AUDIT_ARCH: u32 = 0xc000_00b7;

pub fn apply_baseline() -> Result<(), SandboxError> {
    // SAFETY: PR_SET_NO_NEW_PRIVS with value 1 and zero trailing arguments is documented.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } == -1 {
        return Err(security_error("PR_SET_NO_NEW_PRIVS"));
    }

    let mut filter = vec![
        statement(BPF_LD_W_ABS, 4),
        jump(BPF_JMP_JEQ_K, AUDIT_ARCH, 1, 0),
        statement(BPF_RET_K, SECCOMP_RET_KILL_PROCESS),
        statement(BPF_LD_W_ABS, 0),
    ];

    #[cfg(target_arch = "x86_64")]
    {
        filter.push(jump(BPF_JMP_JGE_K, 0x4000_0000, 0, 1));
        filter.push(statement(BPF_RET_K, SECCOMP_RET_KILL_PROCESS));
    }

    for &syscall in denied_syscalls() {
        filter.push(jump(BPF_JMP_JEQ_K, syscall as u32, 0, 1));
        filter.push(statement(BPF_RET_K, SECCOMP_RET_ERRNO | libc::EPERM as u32));
    }
    filter.push(statement(BPF_RET_K, SECCOMP_RET_ALLOW));

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
        return Err(security_error("PR_SET_SECCOMP"));
    }
    Ok(())
}

fn denied_syscalls() -> &'static [libc::c_long] {
    &[
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_ptrace,
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
        libc::SYS_unshare,
        libc::SYS_setns,
        libc::SYS_seccomp,
        libc::SYS_acct,
        libc::SYS_quotactl,
    ]
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

fn security_error(operation: &str) -> SandboxError {
    SandboxError::Security(format!("{operation}: {}", io::Error::last_os_error()))
}
