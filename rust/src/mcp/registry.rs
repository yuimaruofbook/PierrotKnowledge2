//! The list of external MCP servers this app may connect to
//! (`src/bun/mcp/registry.ts`).
//!
//! Kept in the OS config directory, never in the bundle: a bundle gets
//! committed and shared, API tokens must not travel with it. Nothing here is
//! started implicitly.

use crate::app_paths::{app_data_path, app_data_read_paths};
use crate::shared::mcp_types::VAULT_PLACEHOLDER;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Map, Value};

const FILE: &str = "mcp-servers.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RegisteredServer {
    #[serde(skip)]
    pub id: String,
    pub label: String,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<IndexMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

pub fn registry_path() -> String {
    app_data_path(FILE)
}

fn coerce(id: Option<&str>, value: &Value) -> Option<RegisteredServer> {
    let record = value.as_object()?;
    let text = |key: &str| record.get(key).and_then(Value::as_str).map(str::trim).unwrap_or("");
    let id = id.map(str::trim).unwrap_or_else(|| text("id"));
    let command = text("command");
    if id.is_empty() || command.is_empty() {
        return None;
    }
    let label = match record.get("label").and_then(Value::as_str) {
        Some(l) if !l.trim().is_empty() => l.to_string(),
        _ => id.to_string(),
    };
    let args = record
        .get("args")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect());
    let env = record.get("env").and_then(Value::as_object).and_then(|m| {
        let env: IndexMap<String, String> =
            m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect();
        (!env.is_empty()).then_some(env)
    });
    let cwd = record.get("cwd").and_then(Value::as_str).filter(|c| !c.trim().is_empty()).map(String::from);
    Some(RegisteredServer { id: id.to_string(), label, command: command.to_string(), args, env, cwd })
}

/// Read the registry. A malformed file yields an empty list: the app must
/// still start. Accepts a bare array and the `{ mcpServers: {...} }` shape.
pub fn load_servers() -> Vec<RegisteredServer> {
    for path in app_data_read_paths(FILE) {
        let Some(parsed) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
        else {
            continue;
        };
        if let Some(list) = parsed.as_array() {
            return list.iter().filter_map(|v| coerce(None, v)).collect();
        }
        if let Some(map) = parsed.get("mcpServers").and_then(Value::as_object) {
            return map.iter().filter_map(|(id, spec)| coerce(Some(id), spec)).collect();
        }
    }
    Vec::new()
}

/// Written in the `mcpServers` shape so it can be copied into an agent's config.
pub fn save_servers(servers: &[RegisteredServer]) -> std::io::Result<()> {
    let path = registry_path();
    if let Some(dir) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut map = Map::new();
    for server in servers {
        map.insert(server.id.clone(), serde_json::to_value(server).expect("serialisable"));
    }
    let mut root = Map::new();
    root.insert("mcpServers".into(), Value::Object(map));
    let text = serde_json::to_string_pretty(&Value::Object(root)).expect("serialisable");
    std::fs::write(&path, format!("{text}\n"))
}

pub fn upsert_server(server: RegisteredServer) -> std::io::Result<Vec<RegisteredServer>> {
    let mut servers = load_servers();
    match servers.iter().position(|s| s.id == server.id) {
        Some(at) => servers[at] = server,
        None => servers.push(server),
    }
    save_servers(&servers)?;
    Ok(servers)
}

pub struct ServerPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub package: &'static str,
    pub vault_arg: bool,
    pub env: &'static [&'static str],
    pub note: &'static str,
}

/// Ready-made entries. Tokens are left empty: the user pastes their own.
pub const SERVER_PRESETS: [ServerPreset; 4] = [
    ServerPreset {
        id: "notion",
        label: "Notion",
        package: "@notionhq/notion-mcp-server",
        vault_arg: false,
        env: &["NOTION_TOKEN"],
        note: "Notion のインテグレーションを作成し、取り込みたいページに接続してからトークンを設定してください。",
    },
    ServerPreset {
        id: "github",
        label: "GitHub",
        package: "@modelcontextprotocol/server-github",
        vault_arg: false,
        env: &["GITHUB_PERSONAL_ACCESS_TOKEN"],
        note: "repo 読み取り権限のある Personal Access Token が必要です。",
    },
    ServerPreset {
        id: "gdrive",
        label: "Google Drive",
        package: "@modelcontextprotocol/server-gdrive",
        vault_arg: false,
        env: &[],
        note: "初回は別途 OAuth 認証が必要です（サーバー側の手順に従ってください）。",
    },
    // Read-only by design: moving notes out of Obsidian needs nothing written.
    ServerPreset {
        id: "obsidian",
        label: "Obsidian",
        package: "mcp-obsidian",
        vault_arg: true,
        env: &[],
        note: "",
    },
];

impl ServerPreset {
    pub fn note(&self) -> String {
        if self.vault_arg {
            format!(
                "args の \"{VAULT_PLACEHOLDER}\" を Vault フォルダの絶対パスに書き換えてください。\
                 読み取り専用なので Vault は変更されません。取り込んだノートは raw/ に入ります。"
            )
        } else {
            self.note.to_string()
        }
    }

    pub fn server(&self) -> RegisteredServer {
        let mut args = vec!["-y".to_string(), self.package.to_string()];
        if self.vault_arg {
            args.push(VAULT_PLACEHOLDER.to_string());
        }
        RegisteredServer {
            id: self.id.into(),
            label: self.label.into(),
            command: "npx".into(),
            args: Some(args),
            env: Some(self.env.iter().map(|k| (k.to_string(), String::new())).collect()),
            cwd: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coerces_both_shapes_and_drops_bad_entries() {
        let s = coerce(None, &json!({"id": " a ", "command": "npx", "args": ["-y", 1], "env": {"K": "v", "N": 2}})).unwrap();
        assert_eq!((s.id.as_str(), s.label.as_str()), ("a", "a"));
        assert_eq!(s.args, Some(vec!["-y".to_string()]));
        assert_eq!(s.env.unwrap().len(), 1);
        assert!(coerce(None, &json!({"id": "a"})).is_none());
        assert_eq!(coerce(Some("x"), &json!({"label": "X", "command": "c"})).unwrap().label, "X");
    }

    #[test]
    fn serialises_without_id_in_ts_key_order() {
        let text = serde_json::to_string(&SERVER_PRESETS[3].server()).unwrap();
        assert_eq!(text, r#"{"label":"Obsidian","command":"npx","args":["-y","mcp-obsidian","<VAULT_PATH>"],"env":{}}"#);
    }
}
