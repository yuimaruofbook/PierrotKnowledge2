/**
 * The built-in agent loop, for model servers that cannot speak MCP.
 *
 * Ollama and llama.cpp are model servers, not agent harnesses: they will emit
 * a tool call but there is nothing on their side to execute it. So this runs
 * the loop — call the model, execute what it asked for against the same
 * `callTool` the MCP server uses, feed the result back — until it stops asking.
 *
 * The token discipline that makes SkillSpace worthwhile lives here too, and it
 * is mostly about what is *not* sent:
 *
 *   - Skills are never pre-loaded. The model gets `skill_find` and is told to
 *     use it; a procedure enters the context only after it chose one.
 *   - The tool schemas are trimmed to what a local 4B model can actually use.
 *     A full nineteen-tool surface crowds out the request itself.
 *   - Tool results are truncated. A `retrieve` that returns six thousand
 *     characters into an 8k window ends the conversation.
 */

import { APP_NAME } from "../../shared/app";
import { callTool, TOOLS, type ToolDefinition } from "../mcp/tools";
import { messages } from "../../shared/messages";
import { estimateTokens } from "../../shared/okf/skill";
import type { Workspace } from "../workspace";
import { OpenAiCompatClient, type ChatMessage, type ChatToolDefinition } from "./openai";
import type { AgentRunResult, AgentStep } from "../../shared/agent-types";

export type { AgentRunResult, AgentStep };

/**
 * Tools offered to a local model.
 *
 * A deliberate subset. Local models degrade sharply as the tool list grows, and
 * these nine cover the whole ingest→curate→verify cycle. `skill_find` is first
 * because order influences selection in smaller models.
 */
export const LOCAL_AGENT_TOOLS = [
  "skill_find",
  "skill_open",
  "skill_read",
  "retrieve",
  "search",
  "read_file",
  "list_files",
  "create_concept",
  "write_file",
] as const;

/** Longest a single tool result may be before it is cut down. */
const DEFAULT_RESULT_CHARS = 4000;
const DEFAULT_MAX_ROUNDS = 8;

const SYSTEM_PROMPT = [
  `あなたは ${APP_NAME}（ローカルの Markdown 知識ベース）を操作するアシスタントです。`,
  "",
  "重要な手順:",
  "1. 手順が決まっていそうな作業では、まず skill_find を呼んでください。無料で、名前と説明しか返しません。",
  "2. 適合するスキルがあれば skill_open で本文を読み、その手順に従ってください。",
  "3. スキルが無ければ、search / retrieve で既存の知識を確認してから作業してください。",
  "",
  "層の規約:",
  "- raw/ は原本です。絶対に書き換えないでください。",
  "- wiki/ が正典です。新規ページは create_concept で作ります（frontmatter の type が必須）。",
  "- .rag/ は派生物です。触らないでください。",
  "",
  "回答は日本語で、簡潔に。",
].join("\n");

export interface AgentRunOptions {
  task: string;
  model: string;
  maxRounds?: number;
  /** Stop once the conversation has cost about this much. */
  tokenBudget?: number;
  maxResultChars?: number;
  signal?: AbortSignal;
  /** Called as work happens, so the UI can show progress. */
  onStep?: (step: AgentStep) => void;
}

/** Translate our MCP tool definitions into OpenAI function schemas. */
export function toChatTools(names: readonly string[]): ChatToolDefinition[] {
  const byName = new Map(TOOLS.map((tool: ToolDefinition) => [tool.name, tool]));

  return names.flatMap((name) => {
    const tool = byName.get(name);
    if (!tool) return [];
    return [
      {
        type: "function" as const,
        function: {
          name: tool.name,
          // Local models read the whole description on every turn, so the long
          // guidance written for frontier models is trimmed to its first
          // sentence — the part that says what the tool is for.
          description: firstSentence(tool.description),
          parameters: tool.inputSchema,
        },
      },
    ];
  });
}

function firstSentence(text: string): string {
  const cut = text.search(/(?<=[.。])\s/);
  return cut === -1 ? text : text.slice(0, cut + 1).trim();
}

/**
 * Cut a tool result down to size.
 *
 * Trims from the middle rather than the tail: retrieval output puts its
 * citations at the end, and losing them is worse than losing the middle of the
 * third passage.
 */
export function truncateResult(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.7);
  const tail = limit - head;
  return `${text.slice(0, head)}\n\n…（${text.length - limit} 文字省略）…\n\n${text.slice(-tail)}`;
}

export class LocalAgent {
  constructor(
    private readonly workspace: Workspace,
    private readonly client: OpenAiCompatClient,
    private readonly label: string
  ) {}

  /** Fail before the first round if the model cannot do the job. */
  async check(model: string): Promise<void> {
    if (!model.trim()) throw new Error(messages.agentNoModel(this.label));
    const models = await this.client.listModels();
    if (models.length > 0 && !models.includes(model)) {
      throw new Error(messages.agentModelMissing(model, this.label));
    }
  }

  async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
    const resultChars = options.maxResultChars ?? DEFAULT_RESULT_CHARS;
    const tools = toChatTools(LOCAL_AGENT_TOOLS);

    const history: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: options.task },
    ];

    const steps: AgentStep[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    let rounds = 0;
    let stopReason: AgentRunResult["stopReason"] = "done";
    let answer = "";

    while (rounds < maxRounds) {
      rounds++;

      const response = await this.client.chat({
        model: options.model,
        messages: history,
        tools,
        temperature: 0,
        ...(options.signal ? { signal: options.signal } : {}),
      });

      // Servers vary in what they report; estimate when they report nothing so
      // the budget still means something.
      promptTokens += response.usage.prompt_tokens ?? 0;
      completionTokens +=
        response.usage.completion_tokens ?? estimateTokens(response.message.content);

      const calls = response.message.tool_calls ?? [];

      if (calls.length === 0) {
        answer = response.message.content.trim();
        const step: AgentStep = { kind: "message", text: answer };
        steps.push(step);
        options.onStep?.(step);
        break;
      }

      // Push the assistant turn before the results: the protocol requires every
      // tool result to follow the call it answers.
      history.push(response.message);

      for (const call of calls) {
        const step = await this.execute(call, resultChars);
        steps.push(step);
        options.onStep?.(step);

        history.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: step.result ?? "",
        });
      }

      if (options.tokenBudget && promptTokens + completionTokens >= options.tokenBudget) {
        stopReason = "budget";
        answer = messages.agentBudgetExceeded(options.tokenBudget);
        break;
      }
    }

    if (rounds >= maxRounds && !answer) {
      stopReason = "round-limit";
      answer = messages.agentRoundLimit(maxRounds);
    }

    return { answer, steps, rounds, promptTokens, completionTokens, stopReason };
  }

  /**
   * Run one tool call.
   *
   * A tool that fails is reported back to the model as text rather than thrown:
   * a wrong argument is something a model can correct on the next round, and
   * aborting the run would throw away the work already done.
   */
  private async execute(
    call: { id: string; function: { name: string; arguments: string } },
    resultChars: number
  ): Promise<AgentStep> {
    let args: Record<string, unknown> = {};
    try {
      args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      return {
        kind: "tool",
        name: call.function.name,
        arguments: {},
        result: `引数を JSON として解析できません: ${call.function.arguments}`,
        isError: true,
      };
    }

    try {
      const result = await callTool(this.workspace, call.function.name, args);
      const body = result.content.map((block) => block.text).join("\n");
      return {
        kind: "tool",
        name: call.function.name,
        arguments: args,
        result: truncateResult(body, resultChars),
        ...(result.isError ? { isError: true } : {}),
      };
    } catch (error) {
      return {
        kind: "tool",
        name: call.function.name,
        arguments: args,
        result: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }
}
