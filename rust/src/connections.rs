//! Live connections to external MCP servers, and importing what they return
//! (`src/bun/connections.ts`).
//!
//! Imports land in `raw/` only: that is the ingest step, and third-party text
//! has not been curated into knowledge yet.

use crate::mcp::client::{McpClient, McpServerSpec};
use crate::mcp::registry::{load_servers, registry_path, RegisteredServer};
use crate::okf::bundle::{Bundle, ImportOptions};
use crate::shared::html::{escape_html, looks_like_html};
use crate::shared::js_compat::js_trim;
use crate::shared::mcp_types::{McpToolDefinition, ServerStatus};
use crate::shared::messages;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;
use std::collections::HashMap;

/// Turn a title into a filename that survives every platform. Japanese is
/// kept: it is valid in a filename and keeps the source recognisable.
pub fn to_file_name(title: &str, fallback: &str) -> String {
    let replaced: String = title
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || (c as u32) < 0x20 { ' ' } else { c })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let stripped = collapsed.trim_matches(|c: char| c == '.' || c.is_whitespace());
    let cut: String = stripped.chars().take(80).collect();
    let cleaned = cut.trim();
    if cleaned.is_empty() { fallback.to_string() } else { cleaned.to_string() }
}

/// `raw/<server>/<YYYY-MM-DD>-<title>.<ext>`
pub fn import_path_for(server_id: &str, title: &str, now: DateTime<Utc>, html: bool) -> String {
    let ext = if html { "html" } else { "md" };
    format!(
        "raw/{}/{}-{}.{ext}",
        to_file_name(server_id, "mcp"),
        now.format("%Y-%m-%d"),
        to_file_name(title, "untitled")
    )
}

/// Wrap captured text with a note of where it came from, in the markup the
/// file is written in. The body is never touched; everything around it that
/// came from outside is escaped in the HTML form.
pub fn wrap_imported(title: &str, server_label: &str, tool: &str, args: &Value, body: &str, now: DateTime<Utc>, html: bool) -> String {
    let at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let args = args.to_string();
    let body = js_trim(body);
    if html {
        let e = escape_html;
        return [
            "<!DOCTYPE html>".to_string(),
            "<meta charset=\"utf-8\">".to_string(),
            format!("<title>{}</title>", e(title)),
            "<header>".to_string(),
            format!("<h1>{}</h1>", e(title)),
            "<blockquote>".to_string(),
            format!("<p>取り込み元: {} / ツール <code>{}</code></p>", e(server_label), e(tool)),
            format!("<p>取り込み日時: {}</p>", e(&at)),
            format!("<p>引数: <code>{}</code></p>", e(&args)),
            "</blockquote>".to_string(),
            "</header>".to_string(),
            "<hr>".to_string(),
            String::new(),
            body.to_string(),
            String::new(),
        ]
        .join("\n");
    }
    [
        format!("# {title}"),
        String::new(),
        format!("> 取り込み元: {server_label} / ツール `{tool}`"),
        format!("> 取り込み日時: {at}"),
        format!("> 引数: `{args}`"),
        String::new(),
        "---".to_string(),
        String::new(),
        body.to_string(),
        String::new(),
    ]
    .join("\n")
}

/// Credentials an entry declares but has no value for (`NOTION_TOKEN: ""`).
/// Left empty the server still connects and every call is a 401.
fn missing_credentials(server: &RegisteredServer) -> Vec<&str> {
    server
        .env
        .iter()
        .flatten()
        .filter(|(_, v)| js_trim(v).is_empty())
        .map(|(k, _)| k.as_str())
        .collect()
}

fn connected(client: &mut McpClient) -> Option<&mut McpClient> {
    client.is_connected().then_some(client)
}

#[derive(Default)]
pub struct Connections {
    clients: HashMap<String, McpClient>,
    servers: Vec<RegisteredServer>,
    errors: HashMap<String, String>,
}

impl Connections {
    pub fn refresh(&mut self) {
        self.servers = load_servers();
    }

    pub fn status(&mut self) -> Vec<ServerStatus> {
        if self.servers.is_empty() {
            self.refresh();
        }
        let mut out = Vec::new();
        for server in &self.servers {
            let mut command = vec![server.command.clone()];
            command.extend(server.args.iter().flatten().cloned());
            let client = self.clients.get_mut(&server.id).and_then(connected);
            let mut status = ServerStatus {
                id: server.id.clone(),
                label: server.label.clone(),
                command: command.join(" "),
                connected: client.is_some(),
                server_name: None,
                tool_count: None,
                error: None,
            };
            if let Some(client) = client {
                status.server_name = client.server_name.clone();
                // A momentary failure here is not worth failing the whole list.
                status.tool_count = client.list_tools().ok().map(|t| t.len() as u32);
            } else {
                let missing = missing_credentials(server);
                if !missing.is_empty() {
                    status.error = Some(messages::mcp_credential_missing(&server.label, &missing, &registry_path()));
                }
            }
            if status.error.is_none() {
                status.error = self.errors.get(&server.id).cloned();
            }
            out.push(status);
        }
        out
    }

    fn find(&self, id: &str) -> Result<&RegisteredServer, String> {
        self.servers.iter().find(|s| s.id == id).ok_or_else(|| messages::mcp_unknown_server(id))
    }

    pub fn connect(&mut self, id: &str) -> Result<ServerStatus, String> {
        if self.servers.is_empty() {
            self.refresh();
        }
        if !self.clients.get_mut(id).is_some_and(McpClient::is_connected) {
            let server = self.find(id)?.clone();
            // Before spawning: a server that cannot answer is not worth the npx download.
            let missing = missing_credentials(&server);
            if !missing.is_empty() {
                let reason = messages::mcp_credential_missing(&server.label, &missing, &registry_path());
                self.errors.insert(id.to_string(), reason.clone());
                return Err(reason);
            }
            let env: Vec<(String, String)> = server.env.clone().unwrap_or_default().into_iter().collect();
            let args = server.args.clone().unwrap_or_default();
            let spec = McpServerSpec { command: &server.command, args: &args, env: &env, cwd: server.cwd.as_deref() };
            match McpClient::connect(&spec) {
                Ok(client) => {
                    self.clients.insert(id.to_string(), client);
                    self.errors.remove(id);
                }
                Err(reason) => {
                    self.errors.insert(id.to_string(), reason.clone());
                    return Err(reason);
                }
            }
        }
        Ok(self.status().into_iter().find(|s| s.id == id).expect("registered"))
    }

    pub fn disconnect(&mut self, id: &str) {
        self.clients.remove(id); // Drop closes it
    }

    fn require(&mut self, id: &str) -> Result<&mut McpClient, String> {
        self.clients
            .get_mut(id)
            .and_then(connected)
            .ok_or_else(|| messages::MCP_DISCONNECTED.to_string())
    }

    pub fn list_tools(&mut self, id: &str) -> Result<Vec<McpToolDefinition>, String> {
        self.require(id)?.list_tools()
    }

    /// Run a tool and capture its text output verbatim as a source file.
    pub fn import_from_tool(
        &mut self,
        bundle: &Bundle,
        server_id: &str,
        tool: &str,
        args: &Value,
        title: Option<&str>,
    ) -> Result<(String, usize), String> {
        let result = self.require(server_id)?.call_tool(tool, args)?;
        let body = result.text();
        if result.is_error {
            return Err(if body.is_empty() { messages::mcp_server_error(tool, -1) } else { body });
        }
        if body.is_empty() {
            return Err(messages::IMPORT_EMPTY.to_string());
        }
        let server = self.find(server_id)?;
        let title = match title.map(js_trim) {
            Some(t) if !t.is_empty() => t.to_string(),
            _ => format!("{} {tool}", server.label),
        };
        let html = looks_like_html(&body);
        let now = Utc::now();
        let content = wrap_imported(&title, &server.label, tool, args, &body, now, html);
        let imported = bundle
            .import_to_raw(
                &import_path_for(server_id, &title, now, html),
                &content,
                &ImportOptions { actor: Some(format!("process:{server_id}")), note: Some(format!("via {tool}")) },
            )
            .map_err(|e| e.to_string())?;
        Ok((imported.path, content.len()))
    }

    pub fn close_all(&mut self) {
        self.clients.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    #[test]
    fn file_names_survive_every_platform() {
        assert_eq!(to_file_name(" ..a/b:c\u{1}  日本.. ", "x"), "a b c 日本");
        assert_eq!(to_file_name("...", "fallback"), "fallback");
        let now = Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        assert_eq!(import_path_for("", "t?", now, true), "raw/mcp/2026-01-02-t.html");
    }

    #[test]
    fn wraps_with_escaped_provenance() {
        let now = Utc.with_ymd_and_hms(2026, 1, 2, 3, 4, 5).unwrap();
        let html = wrap_imported("<t>", "L", "tool", &json!({"a": 1}), " <p>x</p> ", now, true);
        assert!(html.contains("<title>&lt;t&gt;</title>"));
        assert!(html.contains("<code>{&quot;a&quot;:1}</code>"));
        assert!(html.ends_with("<hr>\n\n<p>x</p>\n"));
        let md = wrap_imported("T", "L", "tool", &json!({}), "body", now, false);
        assert_eq!(md, "# T\n\n> 取り込み元: L / ツール `tool`\n> 取り込み日時: 2026-01-02T03:04:05.000Z\n> 引数: `{}`\n\n---\n\nbody\n");
    }
}
