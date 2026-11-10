//! RPC handlers the browser interface calls (`src/bun/rpc.ts`).
//!
//! Thin by design: every handler delegates to `Workspace`, which is also what
//! the MCP server drives. Method names and JSON shapes are the contract in
//! `src/shared/rpc-schema.ts`.

use crate::agent::{AgentRun, LocalAgent, OpenAiCompatClient};
use crate::connect::targets::{
    api_key_for, connect_all_targets, connect_target, connect_targets, find_install_root, find_target, is_installed,
    preview_target, server_command_line, server_spec_for, ConnectAllOptions, ConnectOptions, SetupKind, TargetKind,
};
use crate::connections::Connections;
use crate::mcp::registry::{registry_path, upsert_server, SERVER_PRESETS};
use crate::okf::bundle::{ImportOptions, PromoteOptions, WriteOptions};
use crate::okf::parser::{skeleton_concept, ConceptSkeletonOptions};
use crate::okf::paths::Actor;
use crate::platform::Platform;
use crate::rag::fts::SearchOptions;
use crate::shared::messages;
use crate::shared::okf::capture::{capture_path_for, MAX_CAPTURE_BYTES};
use crate::shared::okf::skill::{serialize_skill, SkillSource};
use crate::shared::types::{Layer, SearchFilters};
use crate::shared::update::compare_versions;
use crate::state::{clear_session, load_session, update_session, SessionState};
use crate::update::{fetch_latest_release, find_install_dir, read_installed, FindInstallDirOptions, GithubSource};
use crate::workspace::{CanvasFromLinks, Workspace};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::LazyLock;

const HUMAN: &str = "human:local";
/// Width of the writing column: full width unless the user narrows it.
const DEFAULT_EDITOR_WIDTH: f64 = 100.0;

type Reply = Result<Value, String>;

fn to_json<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).expect("RPC responses are serialisable")
}

fn str_of<'a>(params: &'a Value, key: &str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or("")
}

fn opt_str<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn bool_of(params: &Value, key: &str) -> Option<bool> {
    params.get(key).and_then(Value::as_bool)
}

fn strings_of(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// Whether a path is worth reopening next launch: never a Layer 3 artifact.
pub fn is_worth_restoring(workspace: &Workspace, path: &str) -> bool {
    !path.is_empty()
        && workspace.require_bundle().is_ok_and(|b| b.paths.layer_of(path) != Some(Layer::Rag))
}

static UNSAFE_STEM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[\\/:*?"<>|\s]+"#).expect("valid regex"));
static UNSAFE_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"[\\/:*?"<>|]+"#).expect("valid regex"));
static CANVAS_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.canvas$").expect("valid regex"));
static ASSET_VERSION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)-(\d+\.\d+\.\d+)\.zip$").expect("valid regex"));

pub struct Rpc {
    pub connections: Connections,
    pub platform: Box<dyn Platform>,
    /// This install, for writing the MCP server's command into other tools' configs.
    pub project_root: String,
}

impl Rpc {
    pub fn new(platform: Box<dyn Platform>) -> Self {
        let project_root = find_install_root(None).unwrap_or_else(|| {
            std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
        });
        Self { connections: Connections::default(), platform, project_root }
    }

    pub fn handle(&mut self, ws: &mut Workspace, method: &str, p: &Value, on_step: &mut dyn FnMut(&Value)) -> Reply {
        let e = |error: crate::okf::error::OkfError| error.to_string();
        Ok(match method {
            "pickBundleDir" => {
                let start = ws.require_bundle().ok().map(|b| b.root().to_string());
                to_json(self.platform.pick_directory(start.as_deref()))
            }
            "openBundle" => {
                let info = ws.open(str_of(p, "path")).map_err(e)?;
                // Remembered before anything else can fail.
                update_session(&SessionState {
                    bundle_path: Some(info.root.clone()),
                    last_file: Some(String::new()),
                    ..Default::default()
                });
                to_json(info)
            }
            "closeBundle" => {
                ws.close();
                Value::Null
            }
            "getBundleInfo" => to_json(ws.info()),
            "restoreSession" => {
                let session = load_session();
                let editor_width = session.editor_width.unwrap_or(DEFAULT_EDITOR_WIDTH);
                if let Some(info) = ws.info() {
                    return Ok(json!({ "info": info, "lastFile": null, "editorWidth": editor_width }));
                }
                let empty = json!({ "info": null, "lastFile": null, "editorWidth": editor_width });
                let Some(path) = session.bundle_path.filter(|p| !p.is_empty()) else { return Ok(empty) };
                match ws.open(&path) {
                    Ok(info) => {
                        let last = session.last_file.filter(|f| is_worth_restoring(ws, f));
                        json!({ "info": info, "lastFile": last, "editorWidth": editor_width })
                    }
                    // A moved or deleted folder is not an error worth reporting.
                    Err(_) => {
                        clear_session();
                        empty
                    }
                }
            }
            "setEditorWidth" => {
                let width = p.get("width").and_then(Value::as_f64).unwrap_or(DEFAULT_EDITOR_WIDTH);
                update_session(&SessionState { editor_width: Some(width.round().clamp(40.0, 100.0)), ..Default::default() });
                Value::Null
            }
            "scaffoldBundle" => {
                let path = str_of(p, "path");
                ws.scaffold(path).map_err(e)?;
                to_json(ws.open(path).map_err(e)?)
            }
            "listDir" => to_json(ws.list_dir(str_of(p, "path"), bool_of(p, "recursive").unwrap_or(false)).map_err(e)?),
            "readFile" => {
                let path = str_of(p, "path");
                let result = ws.read_file(path).map_err(e)?;
                if is_worth_restoring(ws, path) {
                    update_session(&SessionState { last_file: Some(path.to_string()), ..Default::default() });
                }
                to_json(result)
            }
            "writeFile" => {
                let opts = WriteOptions { actor: Some(HUMAN.into()), log: bool_of(p, "log"), ..Default::default() };
                to_json(ws.write_file(str_of(p, "path"), str_of(p, "content"), &opts).map_err(e)?)
            }
            "checkForUpdate" => check_for_update(),
            "captureFiles" => {
                let files = p.get("files").and_then(Value::as_array).cloned().unwrap_or_default();
                // Checked before anything is written, so one oversized file does
                // not leave half a batch captured.
                for file in &files {
                    if str_of(file, "content").len() as u64 > MAX_CAPTURE_BYTES {
                        return Err(messages::capture_too_large(str_of(file, "name"), MAX_CAPTURE_BYTES));
                    }
                }
                let mut paths = Vec::new();
                {
                    let bundle = ws.require_bundle().map_err(e)?;
                    let opts = ImportOptions { actor: Some(HUMAN.into()), note: Some("dropped in".into()) };
                    for file in &files {
                        let path = capture_path_for(str_of(file, "name"));
                        paths.push(bundle.import_to_raw(&path, str_of(file, "content"), &opts).map_err(e)?.path);
                    }
                }
                ws.reload_bundle().map_err(e)?;
                json!({ "paths": paths })
            }
            "openDaily" => {
                let (path, created) = ws.open_daily(None).map_err(e)?;
                json!({ "path": path, "created": created })
            }
            "createConcept" => {
                let content = skeleton_concept(&ConceptSkeletonOptions {
                    r#type: str_of(p, "type").into(),
                    title: opt_str(p, "title").map(String::from),
                    description: opt_str(p, "description").map(String::from),
                    tags: strings_of(p, "tags"),
                    body: opt_str(p, "body").map(String::from),
                    generated_by: Some(HUMAN.into()),
                    ..Default::default()
                });
                let opts = WriteOptions { actor: Some(HUMAN.into()), action: Some("create".into()), ..Default::default() };
                to_json(ws.write_file(str_of(p, "path"), &content, &opts).map_err(e)?)
            }
            "search" => {
                let tags = strings_of(p, "tags");
                let options = SearchOptions {
                    limit: Some(p.get("limit").and_then(Value::as_i64).unwrap_or(20)),
                    filters: SearchFilters {
                        r#type: opt_str(p, "type").map(String::from),
                        tags: (!tags.is_empty()).then_some(tags),
                        path_prefix: opt_str(p, "pathPrefix").map(String::from),
                        // A person must be able to find a retired note to revive it.
                        include_dead: Some(true),
                        ..Default::default()
                    },
                    ..Default::default()
                };
                to_json(ws.search(str_of(p, "query"), &options).map_err(e)?)
            }
            "resolveLink" => to_json(ws.resolve_link(str_of(p, "from"), str_of(p, "target")).map_err(e)?),
            "movePath" => to_json(ws.move_file(str_of(p, "from"), str_of(p, "to"), HUMAN, Actor::Human).map_err(e)?),
            "promotePath" => {
                let opts = PromoteOptions { actor: Some(HUMAN.into()), keep_source: bool_of(p, "keepSource") };
                to_json(ws.promote(str_of(p, "from"), str_of(p, "to"), &opts).map_err(e)?)
            }
            "deletePath" => to_json(ws.delete(str_of(p, "path"), HUMAN, Actor::Human).map_err(e)?),
            "createDirectory" => {
                ws.create_directory(str_of(p, "path"), Actor::Human).map_err(e)?;
                Value::Null
            }
            "listConcepts" => to_json(ws.list_concepts().map_err(e)?),
            "listTags" => json!({ "tags": ws.tags().map_err(e)?, "types": ws.types().map_err(e)? }),
            "unresolvedLinks" => to_json(ws.unresolved_links().map_err(e)?),
            // Scheme-checked here: the view renders untrusted note content, and
            // this is the last point a `file:` URL could become a local action.
            "openExternal" => {
                let url = str_of(p, "url");
                let lower = url.to_ascii_lowercase();
                json!((lower.starts_with("http://") || lower.starts_with("https://")) && self.platform.open_external(url))
            }
            "rebuildIndex" => json!({ "rows": ws.rebuild_index().map_err(e)? }),
            "baseView" => ws.base_view(str_of(p, "path"), opt_str(p, "view")),
            "canvasFromLinks" => {
                let root = str_of(p, "root");
                let last = root.rsplit('/').next().unwrap_or(root);
                let mut stem = UNSAFE_STEM.replace_all(last, "-").into_owned();
                if stem.is_empty() {
                    stem = "canvas".into();
                }
                let path = ws.unique_canvas_path(&format!("{stem}-relations")).map_err(e)?;
                let result = ws
                    .canvas_from_links(&CanvasFromLinks {
                        root: Some(root.to_string()),
                        depth: p.get("depth").and_then(Value::as_i64),
                        include_dead: bool_of(p, "includeDead").unwrap_or(false),
                        group_by_para: bool_of(p, "groupByPara").unwrap_or(false),
                        path,
                        by: Actor::Human,
                        ..Default::default()
                    })
                    .map_err(e)?;
                json!({ "path": result.path, "concepts": result.concepts, "edges": result.edges, "truncated": result.truncated })
            }
            "newCanvas" => {
                let name = str_of(p, "name").trim();
                let stem = UNSAFE_NAME.replace_all(&CANVAS_SUFFIX.replace(name, ""), "-").into_owned();
                let path = ws.unique_canvas_path(if stem.is_empty() { "新しいキャンバス" } else { &stem }).map_err(e)?;
                ws.canvas_write(&path, "{\n\t\"nodes\":[],\n\t\"edges\":[]\n}", Actor::Human, None).map_err(e)?;
                json!({ "path": path })
            }
            "rebuildRag" => json!({ "indexed": ws.rebuild_rag().map_err(e)? }),
            "checkConformance" => to_json(ws.conformance_issues().map_err(e)?),

            // ---- external MCP servers ----
            "listConnections" => to_json(self.connections.status()),
            "connectServer" => to_json(self.connections.connect(str_of(p, "id"))?),
            "disconnectServer" => {
                self.connections.disconnect(str_of(p, "id"));
                Value::Null
            }
            "listRemoteTools" => to_json(self.connections.list_tools(str_of(p, "id"))?),
            // Imports land in raw/ only: this is ingest, not curated knowledge.
            "importFromServer" => {
                let args = p.get("args").cloned().unwrap_or_else(|| json!({}));
                let (path, bytes) = self.connections.import_from_tool(
                    ws.require_bundle().map_err(e)?,
                    str_of(p, "id"),
                    str_of(p, "tool"),
                    &args,
                    opt_str(p, "title"),
                )?;
                ws.reload_bundle().map_err(e)?;
                json!({ "path": path, "bytes": bytes })
            }
            "addServerPreset" => {
                let id = str_of(p, "preset");
                let preset = SERVER_PRESETS.iter().find(|s| s.id == id).ok_or_else(|| messages::mcp_unknown_server(id))?;
                upsert_server(preset.server()).map_err(|e| e.to_string())?;
                self.connections.refresh();
                json!({ "servers": self.connections.status(), "note": preset.note() })
            }
            "openServerConfig" => json!(registry_path()),

            // ---- SkillSpace ----
            "listSkills" => to_json(ws.require_skills_mut().map_err(e)?.summaries()),
            "findSkill" => {
                let limit = p.get("limit").and_then(Value::as_u64).map(|n| n as usize).or(Some(3));
                to_json(ws.require_skills_mut().map_err(e)?.find(str_of(p, "task"), limit))
            }
            "openSkillFile" => json!(ws.require_skills().map_err(e)?.rel_path_of(str_of(p, "name"))),
            "listSkillCategories" => to_json(ws.require_skills().map_err(e)?.categories()),
            "createSkill" => {
                let name = str_of(p, "name");
                let path = ws.require_skills().map_err(e)?.new_skill_path(name, str_of(p, "category"));
                // A template rather than empty: a skill with no procedure costs a
                // description in every agent's context and gives nothing back.
                let body = [
                    format!("# {name}"),
                    String::new(),
                    "## いつ使うか".into(),
                    String::new(),
                    "（このスキルが適する状況を書いてください）".into(),
                    String::new(),
                    "## 手順".into(),
                    String::new(),
                    "1. read_agents_md でバンドルの規約を確認する".into(),
                    "2. search で既存の関連ページを探す".into(),
                    "3. （ここに手順を書いてください）".into(),
                ]
                .join("\n");
                let content = serialize_skill(&SkillSource {
                    name: name.into(),
                    description: str_of(p, "description").into(),
                    when: strings_of(p, "when"),
                    body,
                    ..Default::default()
                });
                let opts = WriteOptions { actor: Some(HUMAN.into()), action: Some("create".into()), ..Default::default() };
                ws.write_file(&path, &content, &opts).map_err(e)?;
                ws.require_skills_mut().map_err(e)?.invalidate();
                json!({ "path": path })
            }

            // ---- one-touch connection to other runtimes ----
            "listConnectTargets" => {
                let bundle_root = ws.require_bundle().map(|b| b.root().to_string()).unwrap_or_default();
                let command_line = server_command_line(&self.project_root, &bundle_root);
                let spec = server_spec_for(&self.project_root, &bundle_root);
                let rows: Vec<Value> = connect_targets()
                    .iter()
                    .map(|target| {
                        let config_path = target.config_path(&bundle_root);
                        let mut row = json!({
                            "id": target.id,
                            "label": target.label,
                            "kind": target.kind.as_str(),
                            "configPath": config_path,
                            "installed": is_installed(target),
                            "note": target.note,
                        });
                        if let Some(endpoint) = &target.endpoint {
                            row["endpoint"] = json!(endpoint);
                        }
                        if let Some(setup) = &target.setup_command {
                            row["setupCommand"] = json!(setup(&bundle_root, &command_line, &spec));
                            if matches!(target.setup_kind, Some(SetupKind::Snippet)) {
                                row["setupIsSnippet"] = json!(true);
                            }
                        }
                        // For hosts, "connected" means our entry is already in their file.
                        row["connected"] = json!(
                            target.kind == TargetKind::McpHost
                                && std::fs::read_to_string(&config_path).is_ok_and(|t| t.contains("okf-wiki"))
                        );
                        row
                    })
                    .collect();
                Value::Array(rows)
            }
            "previewConnect" => {
                let root = ws.require_bundle().map_err(e)?.root().to_string();
                let (path, content) = preview_target(str_of(p, "id"), &self.project_root, &root)?;
                json!({ "path": path, "content": content })
            }
            "applyConnect" => {
                let root = ws.require_bundle().map_err(e)?.root().to_string();
                let result = connect_target(&ConnectOptions {
                    target_id: str_of(p, "id"),
                    project_root: &self.project_root,
                    bundle_root: &root,
                    target: None,
                })?;
                let mut out = json!({ "target": result.target, "path": result.path });
                if let Some(backup) = result.backup {
                    out["backup"] = json!(backup);
                }
                out["created"] = json!(result.created);
                if result.unchanged {
                    out["unchanged"] = json!(true);
                }
                out
            }
            "connectAllTargets" => {
                let root = ws.require_bundle().map_err(e)?.root().to_string();
                to_json(connect_all_targets(&ConnectAllOptions {
                    project_root: &self.project_root,
                    bundle_root: &root,
                    include_missing: bool_of(p, "includeMissing").unwrap_or(false),
                    targets: None,
                    probe_installed: None,
                }))
            }

            // ---- the built-in agent ----
            "listLocalModels" => to_json(model_client(str_of(p, "id"))?.list_models()?),
            "runLocalAgent" => {
                let model = str_of(p, "model");
                let mut agent = LocalAgent { workspace: ws, client: model_client(str_of(p, "id"))? };
                agent.check(model)?;
                let run = AgentRun {
                    task: str_of(p, "task"),
                    model,
                    max_rounds: p.get("maxRounds").and_then(Value::as_u64).filter(|n| *n > 0),
                    token_budget: p.get("tokenBudget").and_then(Value::as_u64).filter(|n| *n > 0),
                };
                agent.run(&run, on_step)?
            }
            _ => return Err(format!("unknown method: {method}")),
        })
    }
}

fn model_client(id: &str) -> Result<OpenAiCompatClient, String> {
    let target = find_target(id)?;
    Ok(OpenAiCompatClient::new(target.endpoint.as_deref().unwrap_or(""), &target.label, &api_key_for(target)))
}

/// Is a newer release published? Every failure answers null: being offline is
/// the normal case, not an error. Only looks; nothing is downloaded.
fn check_for_update() -> Value {
    let Some(dir) = find_install_dir(&FindInstallDirOptions::default()) else { return Value::Null };
    let (Ok(installed), Ok(Some(release))) = (read_installed(&dir), fetch_latest_release(&GithubSource::default_source()))
    else {
        return Value::Null;
    };
    let version = ASSET_VERSION.captures(&release.asset_name).map(|c| c[1].to_string());
    if compare_versions(version.as_deref(), Some(&installed.version)) != Some(1) {
        return Value::Null;
    }
    json!({
        "version": version,
        "name": release.name,
        "notes": release.notes,
        "htmlUrl": release.html_url,
        "publishedAt": release.published_at,
    })
}
