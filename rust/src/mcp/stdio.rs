//! MCP over stdio: newline-delimited JSON-RPC 2.0 (`src/bun/mcp/stdio.ts`).
//!
//! MCP's stdio transport frames one JSON object per line. It is not the LSP
//! `Content-Length` framing, and a server that emits headers is silently
//! unreadable by every client. Messages must therefore never contain a raw
//! newline, which is why responses are stringified compactly.

use super::tools::{call_tool, Args, TOOLS};
use crate::shared::app::APP_NAME;
use crate::shared::js_compat::js_trim;
use crate::workspace::Workspace;
use serde_json::{json, Map, Value};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::Duration;

pub const SERVER_NAME: &str = "okf-wiki";
pub const SERVER_VERSION: &str = "0.2.0";

/// Protocol revisions this server implements, newest first.
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const JSONRPC_PARSE_ERROR: i64 = -32700;
const JSONRPC_INVALID_REQUEST: i64 = -32600;
const JSONRPC_METHOD_NOT_FOUND: i64 = -32601;
const JSONRPC_INTERNAL_ERROR: i64 = -32603;

/// MAP first, deliberately. It is a small routing table that names the one
/// file answering each kind of question, so the alternative (read several
/// files to find out where things are) is paid once and never again.
const INSTRUCTIONS: &str = "Call read_map first. MAP.md is small and tells you which single file or tool \
answers each question: read_human for who the user is, list_tasks for what to \
work on, read_agents_md for this bundle's rules, retrieve/search for knowledge. \
Go straight to the one you need. raw/ is immutable to you; .rag/ is derived.";

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Negotiate a protocol version, preferring the client's when we speak it.
pub fn negotiate_protocol(requested: Option<&Value>) -> &'static str {
    if let Some(Value::String(requested)) = requested {
        if let Some(found) = SUPPORTED_PROTOCOL_VERSIONS.iter().find(|v| *v == requested) {
            return found;
        }
    }
    SUPPORTED_PROTOCOL_VERSIONS[0]
}

/// Handle one decoded message.
///
/// Returns `None` for notifications: a JSON-RPC notification has no `id` and
/// must not be answered, and replying to `notifications/initialized` is enough
/// to make strict clients abort the session.
pub fn handle_message(workspace: &mut Workspace, message: &Value) -> Option<Value> {
    // A message that is not an object has no `id`, so it is never answered.
    let object = message.as_object()?;
    let id = match object.get("id") {
        None | Some(Value::Null) => return None,
        Some(id) => id.clone(),
    };

    let Some(Value::String(method)) = object.get("method") else {
        return Some(error(id, JSONRPC_INVALID_REQUEST, "Missing 'method'"));
    };
    let empty = Map::new();
    let params = match object.get("params") {
        Some(Value::Object(p)) => p,
        _ => &empty,
    };

    Some(match method.as_str() {
        "initialize" => ok(
            id,
            json!({
                "protocolVersion": negotiate_protocol(params.get("protocolVersion")),
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "title": APP_NAME, "version": SERVER_VERSION },
                "instructions": INSTRUCTIONS,
            }),
        ),

        "ping" => ok(id, json!({})),

        "tools/list" => ok(id, json!({ "tools": *TOOLS })),

        "tools/call" => {
            let name = match params.get("name") {
                Some(Value::String(n)) => n.as_str(),
                _ => "",
            };
            if name.is_empty() {
                return Some(error(id, JSONRPC_INVALID_REQUEST, "Missing tool name"));
            }
            // Arrays are objects in JS, but carry none of the keys a tool reads.
            let args: Args = match params.get("arguments") {
                Some(Value::Object(a)) => a.clone(),
                _ => Map::new(),
            };
            // Tool failures are already `isError` results; a panic is the only
            // way left to reach the internal-error code.
            let called = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                call_tool(workspace, name, &args)
            }));
            match called {
                Ok(result) => ok(id, result.to_value()),
                Err(cause) => {
                    let message = cause
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| cause.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_else(|| "internal error".to_string());
                    error(id, JSONRPC_INTERNAL_ERROR, &message)
                }
            }
        }

        other => error(id, JSONRPC_METHOD_NOT_FOUND, &format!("Unknown method: {other}")),
    })
}

/// Decode and answer one line of input. `None` for blank lines and notifications.
pub fn handle_line(workspace: &mut Workspace, line: &[u8]) -> Option<Value> {
    // `TextDecoder` replaces invalid sequences rather than failing.
    let decoded = String::from_utf8_lossy(line);
    let line = js_trim(&decoded);
    if line.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(line) {
        Ok(message) => handle_message(workspace, &message),
        Err(_) => Some(error(Value::Null, JSONRPC_PARSE_ERROR, "Parse error")),
    }
}

/// How often the loop wakes to apply file-watcher events while idle.
const IDLE_TICK: Duration = Duration::from_millis(20);

/// Run the newline-delimited JSON-RPC loop until the input closes (or `stop`
/// is set).
///
/// Requests are answered one at a time, in order. A reader thread feeds bytes
/// so the loop can keep applying watcher events while waiting for input, which
/// is what the TS event loop does between requests. Input after the last
/// newline is dropped when the stream ends, as in the TS.
pub fn run_stdio_server(
    workspace: &mut Workspace,
    input: impl Read + Send + 'static,
    mut write: impl FnMut(&str),
    stop: &AtomicBool,
) {
    let (tx, rx) = channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut input = input;
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match input.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(chunk[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut buffer: Vec<u8> = Vec::new();
    while !stop.load(Ordering::SeqCst) {
        match rx.recv_timeout(IDLE_TICK) {
            Ok(bytes) => buffer.extend_from_slice(&bytes),
            Err(RecvTimeoutError::Timeout) => {
                workspace.poll_watcher();
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }

        while let Some(newline) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=newline).collect();
            workspace.poll_watcher();
            if let Some(response) = handle_line(workspace, &line[..line.len() - 1]) {
                write(&format!("{}\n", serde_json::to_string(&response).expect("serialisable")));
            }
        }
    }
}
