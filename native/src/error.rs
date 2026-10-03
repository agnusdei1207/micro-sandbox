use serde::Serialize;
use thiserror::Error;

/// Every error code the Node client accepts from the native supervisor.
const WIRE_CODES: [&str; 8] = [
    "PROTOCOL_ERROR",
    "CGROUP_ERROR",
    "CAPACITY_EXCEEDED",
    "CANCELLED",
    "POLICY_VIOLATION",
    "CGROUP_DELEGATION_REQUIRED",
    "ISOLATION_UNAVAILABLE",
    "INTERNAL_ERROR",
];

#[derive(Debug, Error)]
pub enum SandboxError {
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("invalid cgroup value: {0}")]
    InvalidCgroupValue(String),
    #[error("sandbox capacity is exhausted")]
    CapacityExceeded,
    #[error("sandbox request was cancelled")]
    Cancelled,
    #[error("policy violation: {0}")]
    PolicyViolation(String),
    #[error("cgroup v2 isolation is unavailable: {0}")]
    CgroupUnavailable(String),
    #[error("security control failed: {0}")]
    Security(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// An error reported by another micro-sandbox process, kept with its original code.
    #[error("{message}")]
    Relayed { code: &'static str, message: String },
}

impl SandboxError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Protocol(_) => "PROTOCOL_ERROR",
            Self::InvalidCgroupValue(_) => "CGROUP_ERROR",
            Self::CapacityExceeded => "CAPACITY_EXCEEDED",
            Self::Cancelled => "CANCELLED",
            Self::PolicyViolation(_) => "POLICY_VIOLATION",
            Self::CgroupUnavailable(_) => "CGROUP_DELEGATION_REQUIRED",
            Self::Security(_) => "ISOLATION_UNAVAILABLE",
            Self::Io(_) | Self::Json(_) => "INTERNAL_ERROR",
            Self::Relayed { code, .. } => code,
        }
    }

    /// Rebuilds an error from its wire form; unknown codes are rejected.
    pub fn from_wire(code: &str, message: String) -> Option<Self> {
        let code = WIRE_CODES.into_iter().find(|known| *known == code)?;
        Some(Self::Relayed { code, message })
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
}

impl From<&SandboxError> for ErrorBody {
    fn from(error: &SandboxError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relays_known_wire_codes_verbatim() {
        let error = SandboxError::from_wire("POLICY_VIOLATION", "policy violation: x".into())
            .expect("known code");
        assert_eq!(error.code(), "POLICY_VIOLATION");
        assert_eq!(error.to_string(), "policy violation: x");
        assert!(SandboxError::from_wire("NOT_A_CODE", String::new()).is_none());
        for error in [
            SandboxError::Protocol(String::new()),
            SandboxError::InvalidCgroupValue(String::new()),
            SandboxError::CapacityExceeded,
            SandboxError::Cancelled,
            SandboxError::PolicyViolation(String::new()),
            SandboxError::CgroupUnavailable(String::new()),
            SandboxError::Security(String::new()),
            SandboxError::Io(std::io::Error::other("x")),
        ] {
            assert!(WIRE_CODES.contains(&error.code()), "{}", error.code());
        }
    }
}
