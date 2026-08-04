/**
 * A minimal OpenAI-compatible chat client, for local model servers.
 *
 * Ollama and llama.cpp both expose `/v1/chat/completions` with `tools`, so one
 * client covers both and anything else that copies the shape. Hand-written for
 * the same reason the MCP transport is: the surface actually used here is one
 * endpoint, and an SDK would add megabytes to a build whose whole selling
 * point is that it is small.
 *
 * Verified against a live Ollama: `finish_reason: "tool_calls"` with a
 * `tool_calls` array is what comes back, and thinking models add a
 * non-standard `reasoning` field that must be ignored rather than parsed.
 */

import { messages } from "../../shared/messages";

export interface ChatToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: unknown;
  };
}

export interface ChatToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResponse {
  message: ChatMessage;
  finishReason: string;
  usage: ChatUsage;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ChatToolDefinition[];
  temperature?: number;
  signal?: AbortSignal;
}

export class OpenAiCompatClient {
  constructor(
    /** Base URL including `/v1`, e.g. `http://localhost:11434/v1`. */
    private readonly baseUrl: string,
    private readonly label: string,
    private readonly timeoutMs = 180_000,
    /**
     * Bearer token, for endpoints that want one.
     *
     * Empty for every local server here — Ollama, llama.cpp, LM Studio and
     * vLLM all rely on the loopback bind instead, and sending an
     * `Authorization` header they never asked for is at best noise and at
     * worst a rejected request. It exists so a hosted OpenAI-compatible
     * endpoint can be reached without a second client.
     */
    private readonly apiKey = ""
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  /** Ask the server what it can run. Used to fail early with a clear message. */
  async listModels(): Promise<string[]> {
    const response = await this.fetchJson("/models", { method: "GET" });
    const data = (response as { data?: Array<{ id?: string }> }).data;
    return Array.isArray(data)
      ? data.map((entry) => entry.id).filter((id): id is string => typeof id === "string")
      : [];
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages,
      stream: false,
    };
    if (options.tools?.length) body.tools = options.tools;
    if (options.temperature !== undefined) body.temperature = options.temperature;

    const payload = (await this.fetchJson("/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    })) as {
      choices?: Array<{ message?: ChatMessage; finish_reason?: string }>;
      usage?: ChatUsage;
    };

    const choice = payload.choices?.[0];
    const message = choice?.message;

    return {
      message: {
        role: "assistant",
        content: typeof message?.content === "string" ? message.content : "",
        ...(message?.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
      },
      finishReason: choice?.finish_reason ?? "stop",
      usage: payload.usage ?? {},
    };
  }

  private async fetchJson(path: string, init: RequestInit): Promise<unknown> {
    const url = this.url(path);
    let response: Response;

    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          // Only when there is one: a local server handed a bearer token it
          // never asked for can reject the whole request.
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // A local server that is simply not running is the overwhelmingly common
      // case, so the message names the URL rather than the exception.
      throw new Error(
        messages.agentUnreachable(this.label, url, cause instanceof Error ? cause.message : String(cause))
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(messages.agentUnreachable(this.label, url, `HTTP ${response.status} ${detail.slice(0, 400)}`));
    }

    return response.json();
  }
}
