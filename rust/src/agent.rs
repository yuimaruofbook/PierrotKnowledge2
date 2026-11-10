//! The built-in agent loop, for model servers that cannot speak MCP
//! (`src/bun/agent/loop.ts` and `openai.ts`).
//!
//! Ollama and llama.cpp emit tool calls but run nothing; this calls the model,
//! executes what it asked for through the same `call_tool` the MCP server uses,
//! and feeds the result back until it stops asking. Skills are never
//! pre-loaded, tool schemas are trimmed and results truncated, so a small
//! local context window is spent on the task.

use crate::mcp::tools::{call_tool, TOOLS};
use crate::shared::app::APP_NAME;
use crate::shared::js_compat::{from_utf16, js_trim, to_utf16};
use crate::shared::messages;
use crate::shared::okf::skill::estimate_tokens;
use crate::workspace::Workspace;
use serde_json::{json, Map, Value};
use std::time::Duration;

/// A deliberate subset: local models degrade as the tool list grows.
/// `skill_find` is first because order influences selection in small models.
pub const LOCAL_AGENT_TOOLS: [&str; 9] = [
    "skill_find",
    "skill_open",
    "skill_read",
    "retrieve",
    "search",
    "read_file",
    "list_files",
    "create_concept",
    "write_file",
];

const DEFAULT_RESULT_CHARS: usize = 4000;
const DEFAULT_MAX_ROUNDS: u64 = 8;
const CHAT_TIMEOUT: Duration = Duration::from_secs(180);

fn system_prompt() -> String {
    [
        format!("あなたは {APP_NAME}（ローカルの Markdown 知識ベース）を操作するアシスタントです。"),
        String::new(),
        "重要な手順:".into(),
        "1. 手順が決まっていそうな作業では、まず skill_find を呼んでください。無料で、名前と説明しか返しません。".into(),
        "2. 適合するスキルがあれば skill_open で本文を読み、その手順に従ってください。".into(),
        "3. スキルが無ければ、search / retrieve で既存の知識を確認してから作業してください。".into(),
        String::new(),
        "層の規約:".into(),
        "- raw/ は原本です。絶対に書き換えないでください。".into(),
        "- wiki/ が正典です。新規ページは create_concept で作ります（frontmatter の type が必須）。".into(),
        "- .rag/ は派生物です。触らないでください。".into(),
        String::new(),
        "回答は日本語で、簡潔に。".into(),
    ]
    .join("\n")
}

/// A minimal OpenAI-compatible chat client (`/v1/models`, `/v1/chat/completions`).
pub struct OpenAiCompatClient {
    base_url: String,
    label: String,
    /// Empty for local servers, which may reject a header they never asked for.
    api_key: String,
    /// Set once the server has refused `temperature`.
    no_temperature: std::sync::atomic::AtomicBool,
}

impl OpenAiCompatClient {
    pub fn new(base_url: &str, label: &str, api_key: &str) -> Self {
        Self { base_url: base_url.trim_end_matches('/').to_string(), label: label.into(), api_key: api_key.into(), no_temperature: Default::default() }
    }

    pub fn list_models(&self) -> Result<Vec<String>, String> {
        let response = self.fetch_json("/models", None)?;
        Ok(response
            .get("data")
            .and_then(Value::as_array)
            .map(|d| d.iter().filter_map(|e| e.get("id").and_then(Value::as_str).map(String::from)).collect())
            .unwrap_or_default())
    }

    /// One completion: the assistant message (role, content, tool_calls?) and usage.
    pub fn chat(&self, model: &str, history: &[Value], tools: &[Value]) -> Result<(Value, Value), String> {
        let mut body = json!({ "model": model, "messages": history, "stream": false });
        if !tools.is_empty() {
            body["tools"] = Value::Array(tools.to_vec());
        }
        // Small local models call tools more reliably at 0, but current Claude
        // and OpenAI reasoning models answer 400 to a sampling parameter: try
        // it, and on a 400 resend without and stop offering it.
        use std::sync::atomic::Ordering::Relaxed;
        let payload = if self.no_temperature.load(Relaxed) {
            self.fetch_json("/chat/completions", Some(&body))?
        } else {
            let mut first = body.clone();
            first["temperature"] = json!(0);
            match self.fetch_json("/chat/completions", Some(&first)) {
                Err(e) if e.contains("HTTP 400") && e.to_lowercase().contains("temperature") => {
                    self.no_temperature.store(true, Relaxed);
                    self.fetch_json("/chat/completions", Some(&body))?
                }
                other => other?,
            }
        };
        let message = payload.pointer("/choices/0/message").cloned().unwrap_or(Value::Null);
        let mut out = Map::new();
        out.insert("role".into(), json!("assistant"));
        out.insert("content".into(), json!(message.get("content").and_then(Value::as_str).unwrap_or("")));
        // Ollama's non-standard `reasoning` field is dropped, not parsed.
        if let Some(calls) = message.get("tool_calls").filter(|c| c.as_array().is_some_and(|a| !a.is_empty())) {
            out.insert("tool_calls".into(), calls.clone());
        }
        // DeepSeek and Kimi thinking modes answer 400 when a tool-call turn is
        // replayed without the `reasoning_content` it came with.
        if let Some(reasoning) = message.get("reasoning_content").filter(|r| r.is_string()) {
            out.insert("reasoning_content".into(), reasoning.clone());
        }
        Ok((Value::Object(out), payload.get("usage").cloned().unwrap_or(json!({}))))
    }

    fn fetch_json(&self, path: &str, body: Option<&Value>) -> Result<Value, String> {
        let url = format!("{}{path}", self.base_url);
        let unreachable = |reason: String| messages::agent_unreachable(&self.label, &url, &reason);
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(CHAT_TIMEOUT))
            .build()
            .into();
        let auth = format!("Bearer {}", self.api_key);
        let result = match body {
            Some(body) => {
                let mut request = agent.post(&url).header("Content-Type", "application/json");
                if !self.api_key.is_empty() {
                    request = request.header("Authorization", &auth);
                }
                request.send(body.to_string())
            }
            None => {
                let mut request = agent.get(&url);
                if !self.api_key.is_empty() {
                    request = request.header("Authorization", &auth);
                }
                request.call()
            }
        };
        let mut response = result.map_err(|e| unreachable(e.to_string()))?;
        let text = response.body_mut().read_to_string().unwrap_or_default();
        if !response.status().is_success() {
            let detail: String = text.chars().take(400).collect();
            return Err(unreachable(format!("HTTP {} {detail}", response.status().as_u16())));
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }
}

/// Translate MCP tool definitions into OpenAI function schemas, keeping only
/// the first sentence of each description: local models reread it every turn.
pub fn to_chat_tools(names: &[&str]) -> Vec<Value> {
    names
        .iter()
        .filter_map(|name| TOOLS.iter().find(|t| t.get("name").and_then(Value::as_str) == Some(name)))
        .map(|tool| {
            let description = tool.get("description").and_then(Value::as_str).unwrap_or("");
            json!({
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": first_sentence(description),
                    "parameters": tool.get("inputSchema").cloned().unwrap_or(Value::Null),
                }
            })
        })
        .collect()
}

fn first_sentence(text: &str) -> String {
    let mut prev = None;
    for (i, c) in text.char_indices() {
        if c.is_whitespace() && matches!(prev, Some('.') | Some('。')) {
            return js_trim(&text[..i + c.len_utf8()]).to_string();
        }
        prev = Some(c);
    }
    text.to_string()
}

/// Cut a tool result down to size from the middle: retrieval output puts its
/// citations at the end, and losing them is worse than losing a passage.
pub fn truncate_result(text: &str, limit: usize) -> String {
    let units = to_utf16(text);
    if units.len() <= limit {
        return text.to_string();
    }
    let head = (limit as f64 * 0.7).floor() as usize;
    let tail = limit - head;
    format!(
        "{}\n\n…（{} 文字省略）…\n\n{}",
        from_utf16(&units[..head]),
        units.len() - limit,
        from_utf16(&units[units.len() - tail..])
    )
}

pub struct AgentRun<'a> {
    pub task: &'a str,
    pub model: &'a str,
    pub max_rounds: Option<u64>,
    pub token_budget: Option<u64>,
}

pub struct LocalAgent<'a> {
    pub workspace: &'a mut Workspace,
    pub client: OpenAiCompatClient,
}

impl LocalAgent<'_> {
    /// Fail before the first round if the model cannot do the job.
    pub fn check(&self, model: &str) -> Result<(), String> {
        if js_trim(model).is_empty() {
            return Err(messages::agent_no_model(&self.client.label));
        }
        let models = self.client.list_models()?;
        if !models.is_empty() && !models.iter().any(|m| m == model) {
            return Err(messages::agent_model_missing(model, &self.client.label));
        }
        Ok(())
    }

    /// Run until the model stops calling tools, the round limit or the budget.
    /// Returns the `AgentRunResult` JSON; `on_step` sees each step as it happens.
    pub fn run(&mut self, options: &AgentRun, on_step: &mut dyn FnMut(&Value)) -> Result<Value, String> {
        let max_rounds = options.max_rounds.unwrap_or(DEFAULT_MAX_ROUNDS);
        let tools = to_chat_tools(&LOCAL_AGENT_TOOLS);
        let mut history = vec![
            json!({ "role": "system", "content": system_prompt() }),
            json!({ "role": "user", "content": options.task }),
        ];
        let mut steps: Vec<Value> = Vec::new();
        let (mut prompt_tokens, mut completion_tokens, mut rounds) = (0u64, 0u64, 0u64);
        let mut stop_reason = "done";
        let mut answer = String::new();

        while rounds < max_rounds {
            rounds += 1;
            let (message, usage) = self.client.chat(options.model, &history, &tools)?;
            let content = message["content"].as_str().unwrap_or("").to_string();
            // Servers vary in what they report; estimate so the budget still means something.
            prompt_tokens += usage.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0);
            completion_tokens +=
                usage.get("completion_tokens").and_then(Value::as_u64).unwrap_or_else(|| estimate_tokens(&content));

            let calls = message.get("tool_calls").and_then(Value::as_array).cloned().unwrap_or_default();
            if calls.is_empty() {
                answer = js_trim(&content).to_string();
                let step = json!({ "kind": "message", "text": answer });
                on_step(&step);
                steps.push(step);
                break;
            }

            // The assistant turn goes first: every tool result must follow its call.
            history.push(message);
            for call in &calls {
                let step = self.execute(call);
                on_step(&step);
                history.push(json!({
                    "role": "tool",
                    "tool_call_id": call.get("id").cloned().unwrap_or(Value::Null),
                    "name": call.pointer("/function/name").cloned().unwrap_or(Value::Null),
                    "content": step.get("result").and_then(Value::as_str).unwrap_or(""),
                }));
                steps.push(step);
            }

            if let Some(budget) = options.token_budget.filter(|b| *b > 0) {
                if prompt_tokens + completion_tokens >= budget {
                    stop_reason = "budget";
                    answer = messages::agent_budget_exceeded(budget);
                    break;
                }
            }
        }

        if rounds >= max_rounds && answer.is_empty() {
            stop_reason = "round-limit";
            answer = messages::agent_round_limit(max_rounds);
        }

        Ok(json!({
            "answer": answer,
            "steps": steps,
            "rounds": rounds,
            "promptTokens": prompt_tokens,
            "completionTokens": completion_tokens,
            "stopReason": stop_reason,
        }))
    }

    /// One tool call. Failures go back to the model as text: a wrong argument
    /// is something it can correct next round.
    fn execute(&mut self, call: &Value) -> Value {
        let name = call.pointer("/function/name").and_then(Value::as_str).unwrap_or("");
        let raw = call.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("");
        let args: Value = if raw.is_empty() {
            json!({})
        } else {
            match serde_json::from_str(raw) {
                Ok(args) => args,
                Err(_) => {
                    return json!({
                        "kind": "tool",
                        "name": name,
                        "arguments": {},
                        "result": format!("引数を JSON として解析できません: {raw}"),
                        "isError": true,
                    })
                }
            }
        };
        let map = args.as_object().cloned().unwrap_or_default();
        let result = call_tool(self.workspace, name, &map);
        let mut step = json!({
            "kind": "tool",
            "name": name,
            "arguments": args,
            "result": truncate_result(&result.text, DEFAULT_RESULT_CHARS),
        });
        if result.is_error {
            step["isError"] = json!(true);
        }
        step
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_descriptions_and_results() {
        assert_eq!(first_sentence("Find a skill. Then open it."), "Find a skill.");
        assert_eq!(first_sentence("スキルを探す。 次に"), "スキルを探す。");
        assert_eq!(first_sentence("no stop"), "no stop");
        assert_eq!(truncate_result("short", 10), "short");
        assert_eq!(truncate_result("0123456789abcdefghij", 10), "0123456\n\n…（10 文字省略）…\n\nhij");
    }

    /// A server that refuses `temperature` and returns `reasoning_content`.
    #[test]
    fn drops_refused_temperature_and_keeps_reasoning_content() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = String::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = stream.read(&mut buf).unwrap();
                    request.push_str(&String::from_utf8_lossy(&buf[..n]));
                    if let Some((head, body)) = request.split_once("\r\n\r\n") {
                        let length = head
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        if body.len() >= length {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                let refused = request.contains("\"temperature\"");
                seen.push(refused);
                let (status, body) = if refused {
                    ("400 Bad Request", r#"{"error":"temperature is not supported"}"#)
                } else {
                    ("200 OK", r#"{"choices":[{"message":{"content":"","reasoning_content":"think","tool_calls":[{"id":"1","function":{"name":"search","arguments":"{}"}}]}}]}"#)
                };
                write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            seen
        });
        let client = OpenAiCompatClient::new(&base, "test", "");
        let history = [json!({ "role": "user", "content": "hi" })];
        let (message, _) = client.chat("m", &history, &[]).unwrap();
        assert_eq!(message["reasoning_content"], "think");
        client.chat("m", &history, &[]).unwrap();
        // Refused once, resent without, and never offered again.
        assert_eq!(server.join().unwrap(), [true, false, false]);
    }

    #[test]
    fn offers_the_local_subset_in_order() {
        let tools = to_chat_tools(&LOCAL_AGENT_TOOLS);
        assert_eq!(tools.len(), LOCAL_AGENT_TOOLS.len());
        assert_eq!(tools[0]["function"]["name"], "skill_find");
    }
}
