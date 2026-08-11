use micro_sandbox_native::protocol::{
    MAX_FRAME_BYTES, Request, Response, decode_request, encode_response,
};
use serde_json::json;

#[test]
fn decodes_a_versioned_request() {
    let request = decode_request(br#"{"version":1,"id":7,"type":"health","payload":{}}"#)
        .expect("valid request");

    assert_eq!(
        request,
        Request {
            version: 1,
            id: 7,
            kind: "health".into(),
            payload: json!({})
        }
    );
}

#[test]
fn rejects_unknown_versions_and_oversized_frames() {
    let unsupported = br#"{"version":2,"id":1,"type":"health","payload":{}}"#;
    assert_eq!(
        decode_request(unsupported).unwrap_err().code(),
        "PROTOCOL_ERROR"
    );
    assert_eq!(
        decode_request(&vec![b'x'; MAX_FRAME_BYTES + 1])
            .unwrap_err()
            .code(),
        "PROTOCOL_ERROR"
    );
}

#[test]
fn encodes_one_newline_terminated_response() {
    let encoded = encode_response(&Response::success(9, json!({"ok": true}))).unwrap();

    assert_eq!(encoded.last(), Some(&b'\n'));
    let value: serde_json::Value = serde_json::from_slice(&encoded[..encoded.len() - 1]).unwrap();
    assert_eq!(value["version"], 1);
    assert_eq!(value["id"], 9);
    assert_eq!(value["ok"], true);
}
