use micro_sandbox_native::error::SandboxError;
use micro_sandbox_native::protocol::{
    MAX_FRAME_BYTES, PROTOCOL_VERSION, Response, decode_request, encode_response,
};
use serde_json::json;
use std::io::{self, BufRead, BufReader, BufWriter, Write};

fn main() {
    let result = match std::env::args().nth(1).as_deref() {
        Some("supervise") => supervise(),
        Some("--version" | "-V") => {
            println!("micro-sandbox {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => Err(SandboxError::Protocol(
            "expected `supervise` or `--version`".into(),
        )),
    };
    if let Err(error) = result {
        eprintln!("{}: {error}", error.code());
        std::process::exit(1);
    }
}

fn supervise() -> Result<(), SandboxError> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    while let Some(frame) = read_bounded_frame(&mut reader)? {
        let request = decode_request(&frame)?;
        let (response, shutdown) = match request.kind.as_str() {
            "health" => (
                Response::success(
                    request.id,
                    json!({
                        "status": "ready",
                        "protocolVersion": PROTOCOL_VERSION,
                        "pid": std::process::id(),
                    }),
                ),
                false,
            ),
            "shutdown" => (
                Response::success(request.id, json!({ "status": "closing" })),
                true,
            ),
            _ => {
                let error =
                    SandboxError::Protocol(format!("unsupported request type {:?}", request.kind));
                (Response::failure(request.id, &error), false)
            }
        };
        writer.write_all(&encode_response(&response)?)?;
        writer.flush()?;
        if shutdown {
            break;
        }
    }
    Ok(())
}

fn read_bounded_frame(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, SandboxError> {
    let mut frame = Vec::new();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if frame.is_empty() {
                Ok(None)
            } else {
                Ok(Some(frame))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index);
        if frame.len().saturating_add(take) > MAX_FRAME_BYTES {
            return Err(SandboxError::Protocol("frame exceeds 1 MiB".into()));
        }
        frame.extend_from_slice(&available[..take]);
        let consumed = take + usize::from(newline.is_some());
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(Some(frame));
        }
    }
}
