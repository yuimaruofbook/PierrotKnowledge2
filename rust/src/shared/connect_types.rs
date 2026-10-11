//! What registering with every agent at once reports back
//! (`src/shared/connect-types.ts`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BulkConnectStatus {
    /// Our entry was written into the tool's config.
    Connected,
    /// The config already said exactly this; nothing was written.
    Unchanged,
    /// Its config is not ours to rewrite: the user runs a command instead.
    Manual,
    /// The tool was not found on this machine.
    Skipped,
    /// It was attempted and did not work.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BulkConnectOutcome {
    pub target: String,
    pub label: String,
    pub status: BulkConnectStatus,
    /// The config file involved, so the report says what was touched.
    pub path: String,
    /// Where the previous version was moved, when one was replaced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup: Option<String>,
    /// For `manual`: the command to run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// For `manual`: `command` is a config snippet to paste, not something to run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snippet: Option<bool>,
    /// For `skipped` and `failed`: why.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
