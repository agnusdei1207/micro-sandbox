use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SandboxError {
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("invalid cgroup value: {0}")]
    InvalidCgroupValue(String),
    #[error("sandbox capacity is exhausted")]
    CapacityExceeded,
    #[error("policy violation: {0}")]
    PolicyViolation(String),
    #[error("cgroup v2 isolation is unavailable: {0}")]
    CgroupUnavailable(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

impl SandboxError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Protocol(_) => "PROTOCOL_ERROR",
            Self::InvalidCgroupValue(_) => "CGROUP_ERROR",
            Self::CapacityExceeded => "CAPACITY_EXCEEDED",
            Self::PolicyViolation(_) => "POLICY_VIOLATION",
            Self::CgroupUnavailable(_) => "CGROUP_DELEGATION_REQUIRED",
            Self::Io(_) | Self::Json(_) => "INTERNAL_ERROR",
        }
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
