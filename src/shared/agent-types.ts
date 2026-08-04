/**
 * What the built-in agent reports back.
 *
 * The loop itself is Bun-only — it spawns HTTP requests and executes tools —
 * but the view renders its progress, so the shapes live here rather than being
 * imported across the process boundary.
 */

export interface AgentStep {
  kind: "tool" | "message";
  /** Tool name, for `kind: "tool"`. */
  name?: string;
  arguments?: Record<string, unknown>;
  /** Result text, truncated exactly as the model saw it. */
  result?: string;
  /** Assistant prose, for `kind: "message"`. */
  text?: string;
  isError?: boolean;
}

export interface AgentRunResult {
  answer: string;
  steps: AgentStep[];
  rounds: number;
  promptTokens: number;
  completionTokens: number;
  stopReason: "done" | "round-limit" | "budget";
}
