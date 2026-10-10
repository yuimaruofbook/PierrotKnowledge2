//! Types describing external MCP servers (`src/shared/mcp-types.ts`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Stand-in for a path only the user can supply.
///
/// Left obviously wrong on purpose: a plausible-looking default would fail with
/// "no such directory" and send someone hunting for a bug instead of reading
/// the note.
pub const VAULT_PLACEHOLDER: &str = "<VAULT_PATH>";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDefinition {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JSON Schema for the tool's arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub id: String,
    pub label: String,
    /// The command line, shown so the user can see what will run.
    pub command: String,
    pub connected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_count: Option<u32>,
    /// Last failure, so the panel can explain rather than just fail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
