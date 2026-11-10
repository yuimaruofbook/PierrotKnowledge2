//! The interface, served to a browser you already have open
//! (`src/bun/ui-server.ts`).
//!
//! This process can read and write every file in the bundle and answers HTTP,
//! so two locks are not optional:
//!
//!   - **It binds to 127.0.0.1**, never `0.0.0.0`.
//!   - **Every request carries a token minted for this run.** Otherwise any
//!     page in the same browser could drive the RPC; DNS rebinding defeats an
//!     Origin check on its own. The token rides on the URL handed to the user
//!     and is never written to disk. `/rpc` demands it in the query; static
//!     assets accept the `HttpOnly; SameSite=Strict` cookie set with the page.
//!
//! Threads: one accepts, one per socket does the I/O. Requests are handled on
//! the caller's thread, which owns the `Workspace` (it is not `Send`), one at a
//! time — the same order the TS event loop gives them.

use crate::rpc::Rpc;
use crate::shared::js_compat::decode_uri_component;
use crate::workspace::Workspace;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;
use tungstenite::handshake::derive_accept_key;
use tungstenite::protocol::Role;
use tungstenite::{Message, WebSocket};

/// How often an idle socket thread checks for pushes, and the main loop for watcher events.
const TICK: Duration = Duration::from_millis(20);
/// A request head larger than this is not a browser talking to us.
const MAX_HEAD_BYTES: usize = 16 * 1024;
const HEAD_TIMEOUT: Duration = Duration::from_secs(10);

/// What socket threads tell the loop that owns the workspace.
pub enum Event {
    Open(u64, Sender<String>),
    Call(u64, String),
    Close(u64),
}

/// Senders to every attached browser tab, keyed by socket.
pub type Sockets = Rc<RefCell<HashMap<u64, Sender<String>>>>;

pub fn broadcast(sockets: &Sockets, kind: &str, payload: &Value) {
    let line = json!({ "type": kind, "payload": payload }).to_string();
    for socket in sockets.borrow().values() {
        let _ = socket.send(line.clone());
    }
}

/// A fresh 48-hex-digit token.
pub fn mint_token() -> String {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).expect("the OS random source is available");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Constant-time comparison: a plain `==` leaks the token's prefix through timing.
fn token_matches(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

struct Head {
    path: String,
    query: String,
    headers: HashMap<String, String>,
}

fn read_head(reader: &mut BufReader<TcpStream>) -> Option<Head> {
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let target = line.split_whitespace().nth(1)?.to_string();
    let mut headers = HashMap::new();
    let mut total = line.len();
    loop {
        let mut header = String::new();
        let n = reader.read_line(&mut header).ok()?;
        total += n;
        if n == 0 || total > MAX_HEAD_BYTES {
            return None;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    Some(Head { path: path.to_string(), query: query.to_string(), headers })
}

fn query_param(query: &str, key: &str) -> String {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .find(|(k, _)| *k == key)
        .and_then(|(_, v)| decode_uri_component(v))
        .unwrap_or_default()
}

fn cookie_token(cookie: &str) -> &str {
    cookie
        .split(';')
        .filter_map(|c| c.trim().strip_prefix("okf_token="))
        .next()
        .filter(|v| v.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
        .unwrap_or("")
}

fn respond(stream: &mut TcpStream, status: &str, headers: &[(&str, String)], body: &[u8]) {
    let mut head = format!("HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n", body.len());
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes()).and_then(|()| stream.write_all(body));
}

/// The file a URL path names, only if it stays inside `root`. Both sides are
/// canonicalised, so `..`, symlinks and encoded separators cannot escape.
fn static_file(root: &Path, url_path: &str) -> Option<PathBuf> {
    let rel = if url_path == "/" { "index.html".to_string() } else { decode_uri_component(&url_path[1..])? };
    let path = root.join(rel).canonicalize().ok()?;
    (path.starts_with(root) && path.is_file()).then_some(path)
}

/// The page compiled into this binary, for an install that is only the binary.
fn embedded_file(url_path: &str) -> Option<(&'static str, Vec<u8>)> {
    let rel = if url_path == "/" { "index.html".to_string() } else { decode_uri_component(url_path.get(1..)?)? };
    let (name, bytes) = crate::embedded::VIEW.iter().find(|(name, _)| *name == rel)?;
    Some((content_type_for(Path::new(name)), bytes.to_vec()))
}

fn handle_connection(stream: TcpStream, id: u64, token: &str, view_root: Option<&Path>, events: &Sender<Event>) {
    // A connection that never sends its head must not hold a thread forever.
    if stream.set_read_timeout(Some(HEAD_TIMEOUT)).is_err() {
        return;
    }
    let Ok(read_half) = stream.try_clone() else { return };
    let mut reader = BufReader::new(read_half);
    let mut stream = stream;
    let Some(head) = read_head(&mut reader) else { return };
    let has_query_token = token_matches(&query_param(&head.query, "token"), token);

    if head.path == "/rpc" {
        if !has_query_token {
            return respond(&mut stream, "403 Forbidden", &[], b"forbidden");
        }
        let Some(key) = head.headers.get("sec-websocket-key") else {
            return respond(&mut stream, "400 Bad Request", &[], b"expected websocket");
        };
        let accept = derive_accept_key(key.as_bytes());
        let upgrade = format!(
            "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: {accept}\r\n\r\n"
        );
        if stream.write_all(upgrade.as_bytes()).is_err() {
            return;
        }
        // Whatever the reader buffered past the head belongs to the socket.
        let leftover = reader.buffer().to_vec();
        return serve_socket(stream, leftover, id, events);
    }

    let cookie = head.headers.get("cookie").map(String::as_str).unwrap_or("");
    if !has_query_token && !token_matches(cookie_token(cookie), token) {
        return respond(&mut stream, "403 Forbidden", &[], b"forbidden");
    }
    let found = match view_root {
        Some(root) => static_file(root, &head.path)
            .and_then(|path| Some((content_type_for(&path), std::fs::read(&path).ok()?))),
        None => embedded_file(&head.path),
    };
    let Some((content_type, body)) = found else {
        return respond(&mut stream, "404 Not Found", &[], b"not found");
    };
    let mut headers = vec![("content-type", content_type.to_string())];
    if has_query_token {
        headers.push(("set-cookie", format!("okf_token={token}; Path=/; HttpOnly; SameSite=Strict")));
    }
    respond(&mut stream, "200 OK", &headers, &body);
}

/// Pump one WebSocket: incoming text goes to the loop, pushes and replies go
/// out between reads (a short read timeout makes room for them).
fn serve_socket(stream: TcpStream, leftover: Vec<u8>, id: u64, events: &Sender<Event>) {
    if stream.set_read_timeout(Some(TICK)).is_err() {
        return;
    }
    let mut socket = WebSocket::from_partially_read(stream, leftover, Role::Server, None);
    let (tx, outgoing) = channel::<String>();
    if events.send(Event::Open(id, tx)).is_err() {
        return;
    }
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                if events.send(Event::Call(id, text.to_string())).is_err() {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(_) => break,
        }
        if !drain(&mut socket, &outgoing) {
            break;
        }
    }
    let _ = events.send(Event::Close(id));
}

fn drain(socket: &mut WebSocket<TcpStream>, outgoing: &Receiver<String>) -> bool {
    while let Ok(line) = outgoing.try_recv() {
        if socket.send(Message::text(line)).is_err() {
            return false;
        }
    }
    true
}

/// Bind the loopback listener and start accepting. Returns the port.
/// `view_root` is the built page on disk; `None` serves the compiled-in one.
pub fn listen(port: u16, token: String, view_root: Option<PathBuf>, events: Sender<Event>) -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", port))?;
    let port = listener.local_addr()?.port();
    let view_root = view_root.map(|root| root.canonicalize()).transpose()?;
    std::thread::spawn(move || {
        for (id, stream) in listener.incoming().enumerate() {
            let Ok(stream) = stream else { continue };
            let (token, root, events) = (token.clone(), view_root.clone(), events.clone());
            std::thread::spawn(move || handle_connection(stream, id as u64, &token, root.as_deref(), &events));
        }
    });
    Ok(port)
}

/// Answer calls until `stop` is set, applying watcher events in between.
pub fn run_loop(workspace: &mut Workspace, rpc: &mut Rpc, sockets: &Sockets, events: &Receiver<Event>, stop: &AtomicBool) {
    while !stop.load(Ordering::SeqCst) {
        match events.recv_timeout(TICK) {
            Ok(Event::Open(id, tx)) => {
                sockets.borrow_mut().insert(id, tx);
            }
            Ok(Event::Close(id)) => {
                sockets.borrow_mut().remove(&id);
            }
            Ok(Event::Call(id, raw)) => {
                workspace.poll_watcher();
                let Ok(call) = serde_json::from_str::<Value>(&raw) else { continue };
                let method = call.get("method").and_then(Value::as_str).unwrap_or("");
                let params = call.get("params").cloned().unwrap_or(Value::Null);
                let mut on_step = |step: &Value| broadcast(sockets, "agentStep", step);
                let reply = match rpc.handle(workspace, method, &params, &mut on_step) {
                    Ok(result) => json!({ "id": call.get("id"), "result": result }),
                    // The message, not a trace: it is shown in the status bar.
                    Err(error) => json!({ "id": call.get("id"), "error": error }),
                };
                if let Some(socket) = sockets.borrow().get(&id) {
                    let _ = socket.send(reply.to_string());
                }
            }
            Err(RecvTimeoutError::Timeout) => workspace.poll_watcher(),
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_and_cookies() {
        let token = mint_token();
        assert_eq!(token.len(), 48);
        assert!(token_matches(&token, &token.clone()));
        assert!(!token_matches(&token, "ab"));
        assert_eq!(cookie_token("a=1; okf_token=beef; b=2"), "beef");
        assert_eq!(cookie_token("okf_token=BEEF"), "");
        assert_eq!(query_param("x=1&token=a%62", "token"), "ab");
    }

    #[test]
    fn static_files_stay_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("view");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.html"), "x").unwrap();
        std::fs::write(dir.path().join("secret"), "s").unwrap();
        let root = root.canonicalize().unwrap();
        assert!(static_file(&root, "/").is_some());
        assert!(static_file(&root, "/../secret").is_none());
        assert!(static_file(&root, "/%2e%2e/secret").is_none());
        assert!(static_file(&root, "/missing.js").is_none());
    }
}
