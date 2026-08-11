use crate::error::{ErrorBody, SandboxError};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Request {
    pub version: u32,
    pub id: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Serialize)]
pub struct Response {
    version: u32,
    id: u64,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

impl Response {
    pub const fn success(id: u64, result: Value) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(id: u64, error: &SandboxError) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id,
            ok: false,
            result: None,
            error: Some(error.into()),
        }
    }
}

pub fn decode_request(frame: &[u8]) -> Result<Request, SandboxError> {
    if frame.len() > MAX_FRAME_BYTES {
        return Err(SandboxError::Protocol("frame exceeds 1 MiB".into()));
    }
    let request: Request =
        serde_json::from_slice(frame).map_err(|error| SandboxError::Protocol(error.to_string()))?;
    if request.version != PROTOCOL_VERSION {
        return Err(SandboxError::Protocol(format!(
            "unsupported version {}",
            request.version
        )));
    }
    if request.kind.is_empty() {
        return Err(SandboxError::Protocol("request type is empty".into()));
    }
    Ok(request)
}

pub fn encode_response(response: &Response) -> Result<Vec<u8>, SandboxError> {
    let mut encoded = serde_json::to_vec(response)?;
    if encoded.len() > MAX_FRAME_BYTES {
        return Err(SandboxError::Protocol("response exceeds 1 MiB".into()));
    }
    encoded.push(b'\n');
    Ok(encoded)
}
