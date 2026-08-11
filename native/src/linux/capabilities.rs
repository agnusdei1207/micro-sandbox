use crate::error::SandboxError;
use std::fs;
use std::io;

const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
const PR_CAP_AMBIENT: libc::c_int = 47;
const PR_CAP_AMBIENT_CLEAR_ALL: libc::c_ulong = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CapabilityMasks {
    pub inheritable: u64,
    pub permitted: u64,
    pub effective: u64,
    pub bounding: u64,
    pub ambient: u64,
}

#[repr(C)]
struct CapabilityHeader {
    version: u32,
    pid: i32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CapabilityData {
    effective: u32,
    permitted: u32,
    inheritable: u32,
}

pub fn drop_all() -> Result<(), SandboxError> {
    let last_capability = fs::read_to_string("/proc/sys/kernel/cap_last_cap")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .unwrap_or(63)
        .min(255);

    for capability in 0..=last_capability {
        // SAFETY: PR_CAPBSET_DROP accepts an integer capability and no pointer arguments.
        let result = unsafe { libc::prctl(libc::PR_CAPBSET_DROP, capability, 0, 0, 0) };
        if result == -1 {
            let error = io::Error::last_os_error();
            if !matches!(error.raw_os_error(), Some(libc::EINVAL) | Some(libc::EPERM)) {
                return Err(SandboxError::Security(format!(
                    "dropping capability {capability}: {error}"
                )));
            }
        }
    }

    let mut header = CapabilityHeader {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let mut data = [CapabilityData {
        effective: 0,
        permitted: 0,
        inheritable: 0,
    }; 2];
    // SAFETY: capset receives a valid versioned header and two writable capability data records.
    let result = unsafe { libc::syscall(libc::SYS_capset, &mut header, data.as_mut_ptr()) };
    if result == -1 {
        return Err(SandboxError::Security(format!(
            "capset: {}",
            io::Error::last_os_error()
        )));
    }

    // SAFETY: clearing ambient capabilities has no pointer arguments.
    let result = unsafe { libc::prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) };
    if result == -1 && io::Error::last_os_error().raw_os_error() != Some(libc::EINVAL) {
        return Err(SandboxError::Security(format!(
            "clearing ambient capabilities: {}",
            io::Error::last_os_error()
        )));
    }
    let masks = capability_masks()?;
    if masks
        != (CapabilityMasks {
            inheritable: 0,
            permitted: 0,
            effective: 0,
            bounding: 0,
            ambient: 0,
        })
    {
        return Err(SandboxError::Security(format!(
            "capability masks remain set: {masks:?}"
        )));
    }
    Ok(())
}

pub fn capability_masks() -> Result<CapabilityMasks, SandboxError> {
    let status = fs::read_to_string("/proc/self/status")?;
    Ok(CapabilityMasks {
        inheritable: parse_mask(&status, "CapInh")?,
        permitted: parse_mask(&status, "CapPrm")?,
        effective: parse_mask(&status, "CapEff")?,
        bounding: parse_mask(&status, "CapBnd")?,
        ambient: parse_mask(&status, "CapAmb")?,
    })
}

fn parse_mask(status: &str, name: &str) -> Result<u64, SandboxError> {
    status
        .lines()
        .find_map(|line| line.strip_prefix(&format!("{name}:\t")))
        .and_then(|value| u64::from_str_radix(value, 16).ok())
        .ok_or_else(|| SandboxError::Security(format!("cannot read {name}")))
}
