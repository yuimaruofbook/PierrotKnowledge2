/**
 * Typed RPC contract between the Bun main process and the webview.
 *
 * Each side declares the `requests` it *handles* and the `messages` it
 * *receives*. Requests are request/response; messages are fire-and-forget
 * pushes.
 *
 * All filesystem authority lives on the Bun side — the webview holds no paths
 * it did not receive from here, and never touches disk itself.
 */

import type { McpToolDefinition, ServerStatus } from "./mcp-types";
import type { BulkConnectOutcome } from "./connect-types";
import type { SkillSummary } from "./okf/skill";
import type { AgentRunResult, AgentStep } from "./agent-types";
import type {
  BundleInfo,
  ConformanceIssue,
  FileNode,
  ReadFileResult,
  SearchFilters,
  SearchHit,
  TagCount,
  WriteFileResult,
} from "./types";

export interface OpenBundleParams {
  path: string;
}

export interface ListDirParams {
  /** Bundle-relative path; empty string means the bundle root. */
  path?: string;
  recursive?: boolean;
}

export interface ReadFileParams {
  path: string;
}

export interface WriteFileParams {
  path: string;
  content: string;
  /** Append a `log.md` row for this write. Defaults to true. */
  log?: boolean;
}

export interface CreateConceptParams {
  path: string;
  type: string;
  title?: string;
  description?: string;
  tags?: string[];
  body?: string;
}

export interface SearchParams extends SearchFilters {
  query: string;
  limit?: number;
}

export interface MovePathParams {
  from: string;
  to: string;
}

export interface DeletePathParams {
  path: string;
}

export interface CreateDirectoryParams {
  path: string;
}

/** An entry in the quick switcher. */
export interface ConceptSummary {
  id: string;
  path: string;
  title: string;
  type: string;
}

export interface ResolveLinkParams {
  /** Concept id the link was written in. */
  from: string;
  /** Raw link target. */
  target: string;
}

/** Bun → webview push payloads. */
export interface FileChangedMessage {
  /** Bundle-relative paths that changed on disk outside the editor. */
  paths: string[];
  /** Bundle counters after the change, so the UI can refresh cheaply. */
  info: BundleInfo;
}

export type OkfRpcSchema = {
  bun: {
    requests: {
      pickBundleDir: { params: void; response: string | null };
      openBundle: { params: OpenBundleParams; response: BundleInfo };
      closeBundle: { params: void; response: void };
      getBundleInfo: { params: void; response: BundleInfo | null };
      /**
       * Reopen whatever was open last time, so a restart lands the user back
       * where they were instead of on a blank window.
       */
      restoreSession: {
        params: void;
        response: { info: BundleInfo | null; lastFile: string | null; editorWidth: number };
      };
      scaffoldBundle: { params: OpenBundleParams; response: BundleInfo };

      listDir: { params: ListDirParams; response: FileNode[] };
      readFile: { params: ReadFileParams; response: ReadFileResult };
      writeFile: { params: WriteFileParams; response: WriteFileResult };
      createConcept: { params: CreateConceptParams; response: WriteFileResult };
      /**
       * Is there a newer release? Null when offline or when there is not.
       *
       * Never throws at the caller: an update check failing is not a reason
       * to interrupt someone writing notes.
       */
      checkForUpdate: {
        params: Record<string, never>;
        response: {
          version: string | null;
          name: string;
          notes: string;
          htmlUrl: string;
          publishedAt: string;
        } | null;
      };
      /** Today's daily note, created from the template when absent. */
      openDaily: { params: Record<string, never>; response: { path: string; created: boolean } };

      search: { params: SearchParams; response: SearchHit[] };
      resolveLink: { params: ResolveLinkParams; response: string | null };

      movePath: {
        params: MovePathParams;
        response: { moved: string; updated: string[]; linkCount: number };
      };
      /** Bring a file up from raw/ into the wiki layer. Human-only. */
      promotePath: {
        params: { from: string; to: string; keepSource?: boolean };
        response: { promoted: string; source: string; kept: boolean };
      };
      deletePath: {
        params: DeletePathParams;
        response: { deleted: string; brokenLinksFrom: string[] };
      };
      createDirectory: { params: CreateDirectoryParams; response: void };

      listConcepts: { params: void; response: ConceptSummary[] };
      listTags: { params: void; response: { tags: TagCount[]; types: TagCount[] } };
      unresolvedLinks: { params: void; response: Array<{ from: string; target: string }> };

      openExternal: { params: { url: string }; response: boolean };

      /** Width of the writing column, as a percentage of the pane. */
      setEditorWidth: { params: { width: number }; response: void };

      /** External MCP servers this app can pull from. */
      listConnections: { params: void; response: ServerStatus[] };
      connectServer: { params: { id: string }; response: ServerStatus };
      disconnectServer: { params: { id: string }; response: void };
      listRemoteTools: { params: { id: string }; response: McpToolDefinition[] };
      importFromServer: {
        params: { id: string; tool: string; args: Record<string, unknown>; title?: string };
        response: { path: string; bytes: number };
      };
      /**
       * The note travels with the servers.
       *
       * A preset carries a sentence about what the service needs before it
       * can answer — a Notion integration has to be created and given access
       * to the pages you want. That was dropped on the way into the registry,
       * so the one moment it was useful, nobody saw it.
       */
      addServerPreset: {
        params: { preset: string };
        response: { servers: ServerStatus[]; note: string };
      };
      openServerConfig: { params: void; response: string };

      /** SkillSpace: the cheap tier stays cheap across the RPC boundary too. */
      listSkills: { params: void; response: SkillSummary[] };
      findSkill: {
        params: { task: string; limit?: number };
        response: {
          ranked: Array<{ name: string; description: string; score: number; matched: string[] }>;
          confidence: "high" | "medium" | "low";
          topTokens: number;
        };
      };
      openSkillFile: { params: { name: string }; response: string };
      createSkill: {
        params: { name: string; description: string; when?: string[]; category?: string };
        response: { path: string };
      };
      /** Categories currently in use, for grouping the skills list. */
      listSkillCategories: { params: void; response: string[] };

      /** One-touch connection to other agent runtimes. */
      listConnectTargets: {
        params: void;
        response: Array<{
          id: string;
          label: string;
          kind: "mcp-host" | "model-server";
          configPath: string;
          installed: boolean;
          note: string;
          endpoint?: string;
          /** A command for the user to run, when we must not write the file. */
          setupCommand?: string;
          connected: boolean;
        }>;
      };
      previewConnect: { params: { id: string }; response: { path: string; content: string } };
      applyConnect: {
        params: { id: string };
        response: { target: string; path: string; backup?: string; created: boolean };
      };
      /**
       * Register with every agent found on this machine, in one action.
       *
       * `includeMissing` also writes for hosts whose executable is not on
       * PATH — a real install the probe cannot see, which Cursor on Windows
       * often is.
       */
      connectAllTargets: {
        params: { includeMissing?: boolean };
        response: BulkConnectOutcome[];
      };

      /** The built-in agent, for model servers that cannot speak MCP. */
      listLocalModels: { params: { id: string }; response: string[] };
      runLocalAgent: {
        params: { id: string; model: string; task: string; maxRounds?: number; tokenBudget?: number };
        response: AgentRunResult;
      };

      rebuildIndex: { params: void; response: { rows: number } };
      rebuildRag: { params: void; response: { indexed: number } };
      checkConformance: { params: void; response: ConformanceIssue[] };
    };
    messages: Record<never, unknown>;
  };
  webview: {
    requests: {};
    messages: {
      bundleOpened: BundleInfo;
      bundleClosed: void;
      fileChanged: FileChangedMessage;
      /** Progress from the built-in agent, so the UI can show work as it happens. */
      agentStep: AgentStep;
    };
  };
};
