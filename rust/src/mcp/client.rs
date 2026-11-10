//! MCP client over stdio (`src/bun/mcp/client.ts`): the mirror of
//! `stdio.rs`, connecting this app *to* other people's MCP servers.
//!
//! Requests are made one at a time by the UI loop, so one reader thread and
//! one channel are enough: replies with an id nobody waits for any more (a
//! request that timed out) are skipped.

use crate::connect::targets::resolve_command;
use crate::shared::app::{APP_ID, APP_NAME};
use crate::shared::mcp_types::McpToolDefinition;
use crate::shared::messages;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Protocol revisions this client can speak, newest first.
pub const CLIENT_PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Extra grace for `initialize`, which may run an `npx` download first.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120);
/// Stderr chunks kept for diagnostics.
const STDERR_TAIL: usize = 200;

pub struct McpServerSpec<'a> {
    pub command: &'a str,
    pub args: &'a [String],
    pub env: &'a [(String, String)],
    pub cwd: Option<&'a str>,
}

/// One tool result: `content` blocks and the `isError` flag.
#[derive(Debug, Clone, Default)]
pub struct McpToolResult {
    pub content: Vec<Value>,
    pub is_error: bool,
}

impl McpToolResult {
    /// The text blocks joined, which is what callers want.
    pub fn text(&self) -> String {
        let parts: Vec<&str> = self
            .content
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect();
        crate::shared::js_compat::js_trim(&parts.join("\n")).to_string()
    }
}

pub struct McpClient {
    child: Child,
    stdin: ChildStdin,
    lines: Receiver<Value>,
    stderr: Arc<Mutex<VecDeque<String>>>,
    next_id: u64,
    closed: bool,
    pub server_name: Option<String>,
}

impl McpClient {
    /// Spawn the server and complete the handshake.
    pub fn connect(spec: &McpServerSpec) -> Result<Self, String> {
        let mut command = Command::new(resolve_command(spec.command));
        command.args(spec.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        command.envs(spec.env.iter().map(|(k, v)| (k, v)));
        if let Some(cwd) = spec.cwd {
            command.current_dir(cwd);
        }
        let mut child =
            command.spawn().map_err(|e| messages::mcp_spawn_failed(spec.command, &e.to_string()))?;

        let stdin = child.stdin.take().expect("piped");
        let stdout = child.stdout.take().expect("piped");
        let mut stderr_pipe = child.stderr.take().expect("piped");

        let (tx, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                // Servers that print logs to stdout are common: not a reply, not fatal.
                if let Ok(message) = serde_json::from_str::<Value>(line.trim()) {
                    if tx.send(message).is_err() {
                        break;
                    }
                }
            }
        });
        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        let tail = Arc::clone(&stderr);
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(n) = stderr_pipe.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                let mut tail = tail.lock().unwrap_or_else(|e| e.into_inner());
                tail.push_back(String::from_utf8_lossy(&chunk[..n]).into_owned());
                while tail.len() > STDERR_TAIL {
                    tail.pop_front();
                }
            }
        });

        let mut client = Self { child, stdin, lines, stderr, next_id: 1, closed: false, server_name: None };
        let params = json!({
            "protocolVersion": CLIENT_PROTOCOL_VERSIONS[0],
            "capabilities": {},
            "clientInfo": { "name": APP_ID, "title": APP_NAME, "version": "0.2.0" },
        });
        match client.request("initialize", params, HANDSHAKE_TIMEOUT) {
            Ok(result) => {
                client.server_name =
                    result.pointer("/serverInfo/name").and_then(Value::as_str).map(String::from);
                // Required by the spec: the server may not send anything until it arrives.
                client.notify("notifications/initialized");
                Ok(client)
            }
            Err(error) => {
                client.close();
                Err(error)
            }
        }
    }

    pub fn is_connected(&mut self) -> bool {
        !self.closed && matches!(self.child.try_wait(), Ok(None))
    }

    pub fn list_tools(&mut self) -> Result<Vec<McpToolDefinition>, String> {
        let result = self.request("tools/list", json!({}), DEFAULT_TIMEOUT)?;
        let tools = result.get("tools").cloned().unwrap_or(Value::Array(Vec::new()));
        Ok(serde_json::from_value(tools).unwrap_or_default())
    }

    pub fn call_tool(&mut self, name: &str, args: &Value) -> Result<McpToolResult, String> {
        let result = self.request("tools/call", json!({ "name": name, "arguments": args }), DEFAULT_TIMEOUT)?;
        Ok(McpToolResult {
            content: result.get("content").and_then(Value::as_array).cloned().unwrap_or_default(),
            is_error: result.get("isError").and_then(Value::as_bool).unwrap_or(false),
        })
    }

    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    fn diagnostics(&self) -> String {
        let tail = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
        crate::shared::js_compat::js_trim(&tail.iter().cloned().collect::<String>()).to_string()
    }

    fn write_line(&mut self, message: &Value) -> std::io::Result<()> {
        let line = format!("{message}\n");
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.flush()
    }

    fn notify(&mut self, method: &str) {
        // A notification that cannot be delivered is not worth failing over.
        let _ = self.write_line(&json!({ "jsonrpc": "2.0", "method": method, "params": {} }));
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        if self.closed {
            return Err(messages::MCP_DISCONNECTED.to_string());
        }
        let id = self.next_id;
        self.next_id += 1;
        self.write_line(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .map_err(|e| e.to_string())?;

        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.lines.recv_timeout(left) {
                Ok(message) => {
                    if message.get("id").and_then(Value::as_u64) != Some(id) {
                        continue; // a notification, a request from the server, or a stale reply
                    }
                    if let Some(error) = message.get("error") {
                        let reason = error.get("message").and_then(Value::as_str).unwrap_or("");
                        let code = error.get("code").and_then(Value::as_i64).unwrap_or(0);
                        return Err(messages::mcp_server_error(reason, code));
                    }
                    return Ok(message.get("result").cloned().unwrap_or(Value::Null));
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err(messages::mcp_timeout(method, timeout.as_millis() as f64));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    self.closed = true;
                    let code = self.child.wait().ok().and_then(|s| s.code()).unwrap_or(-1);
                    return Err(messages::mcp_exited(i64::from(code), &self.diagnostics()));
                }
            }
        }
    }
}

impl Drop for McpClient {
    fn drop(&mut self) {
        self.close();
    }
}
