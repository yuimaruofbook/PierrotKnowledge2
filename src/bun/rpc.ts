/**
 * RPC request handlers exposed to the webview.
 *
 * Thin by design: every handler is a direct delegation to `Workspace`, which is
 * also what the MCP server calls. Business rules live there, not here.
 */

import { readFile } from "fs/promises";
import { resolve } from "path";
import type { OkfRpcSchema } from "../shared/rpc-schema";
import { messages } from "../shared/messages";
import { skeletonConcept } from "./okf/parser";
import type { Connections } from "./connections";
import { SERVER_PRESETS, registryPath, upsertServer } from "./mcp/registry";
import { clearSession, loadSession, updateSession } from "./state";
import { serializeSkill } from "../shared/okf/skill";
import {
  CONNECT_TARGETS,
  connectAllTargets,
  connectTarget,
  findInstallRoot,
  findTarget,
  isInstalled,
  previewTarget,
  serverCommandLine,
} from "./connect/targets";
import { LocalAgent } from "./agent/loop";
import { OpenAiCompatClient } from "./agent/openai";
import type { AgentStep } from "../shared/agent-types";
import type { Workspace } from "./workspace";
import type { Platform } from "./platform";

type Handlers = {
  [K in keyof OkfRpcSchema["bun"]["requests"]]: (
    params: OkfRpcSchema["bun"]["requests"][K]["params"]
  ) =>
    | OkfRpcSchema["bun"]["requests"][K]["response"]
    | Promise<OkfRpcSchema["bun"]["requests"][K]["response"]>;
};

/**
 * Whether a path is worth reopening on the next launch.
 *
 * Layer 3 holds SQLite artifacts (`fts.sqlite-wal` and friends) that the app
 * reads for its own purposes. Restoring one of those puts binary noise in the
 * editor instead of the note the user was writing, so the pointer is only ever
 * allowed to name something a person would actually have been reading.
 */
export function isWorthRestoring(workspace: Workspace, path: string): boolean {
  if (!path) return false;
  try {
    return workspace.requireBundle().paths.layerOf(path) !== "rag";
  } catch {
    return false;
  }
}

/**
 * This repository's root, so a generated config can point at the MCP server.
 *
 * Derived from this module's own location rather than `process.cwd()`: the app
 * is launched from a desktop shortcut, where the working directory is whatever
 * the shell happened to hand it.
 */
/**
 * Where this installation keeps the MCP server, for writing into other tools'
 * configs.
 *
 * Not `resolve(import.meta.dir, "..", "..")`, which is only correct when
 * running from a source checkout: packaged, `import.meta.dir` is a virtual
 * path and that arithmetic yielded `B:/`, so the connection panel wrote agents
 * a command pointing at `B:/src/bun/mcp/standalone.ts`. Every config looked
 * fine and no agent could start the server.
 *
 * The fallback keeps the old behaviour for a checkout that has not been built,
 * where nothing is on disk to find yet.
 */
const PROJECT_ROOT = findInstallRoot() ?? resolve(import.meta.dir, "..", "..");

/**
 * Default width of the writing column, as a percentage of the pane.
 *
 * Full width. A measured column is a preference, not a default to impose —
 * the slider is there for anyone who wants one.
 */
const DEFAULT_EDITOR_WIDTH = 100;

export function createRequestHandlers(
  workspace: Workspace,
  connections: Connections,
  platform: Platform,
  onStep: (step: AgentStep) => void = () => {}
): Handlers {
  return {
    async pickBundleDir() {
      // Open the dialog beside the bundle already in use: switching bundles
      // means landing near it far more often than at the filesystem root.
      return platform.pickDirectory(
        workspace.isOpen ? { start: workspace.requireBundle().root } : {}
      );
    },

    async openBundle({ path }) {
      const info = await workspace.open(path);
      // Remember it before anything else can fail, so the next launch lands
      // here even if the session ends badly.
      await updateSession({ bundlePath: info.root, lastFile: "" });
      return info;
    },

    closeBundle: () => workspace.close(),

    getBundleInfo: () => workspace.info(),

    /**
     * Reopen the last bundle, if it still exists.
     *
     * A folder that has been moved or deleted is not an error worth reporting —
     * the session pointer is cleared and the user gets the welcome screen.
     */
    async restoreSession() {
      const session = await loadSession();
      const editorWidth = session.editorWidth ?? DEFAULT_EDITOR_WIDTH;

      const open = await workspace.info();
      if (open) return { info: open, lastFile: null, editorWidth };

      if (!session.bundlePath) return { info: null, lastFile: null, editorWidth };

      try {
        const info = await workspace.open(session.bundlePath);
        // A pointer written by an older build may still name something
        // unsuitable; check again rather than trusting what is on disk.
        const lastFile =
          session.lastFile && isWorthRestoring(workspace, session.lastFile)
            ? session.lastFile
            : null;
        return { info, lastFile, editorWidth };
      } catch {
        await clearSession();
        return { info: null, lastFile: null, editorWidth };
      }
    },

    /** Remember the writing column width. Clamped to what stays usable. */
    async setEditorWidth({ width }) {
      await updateSession({ editorWidth: Math.min(100, Math.max(40, Math.round(width))) });
    },

    async scaffoldBundle({ path }) {
      await workspace.scaffold(path);
      return workspace.open(path);
    },

    listDir: ({ path, recursive }) => workspace.listDir(path ?? "", recursive ?? false),

    async readFile({ path }) {
      const result = await workspace.readFile(path);
      if (isWorthRestoring(workspace, path)) void updateSession({ lastFile: path });
      return result;
    },

    writeFile: ({ path, content, log }) =>
      workspace.writeFile(path, content, {
        actor: "human:local",
        ...(log === undefined ? {} : { log }),
      }),

    /**
     * Is a newer release published?
     *
     * Deliberately swallows every failure and answers null. Being offline, or
     * GitHub being slow, is the normal case for someone writing notes on a
     * train — surfacing it as an error would train them to ignore the panel
     * that also carries real errors.
     *
     * This only *looks*. Nothing is downloaded and nothing is written; the
     * install still happens through `PierrotKnowledge2 Update`, deliberately.
     */
    async checkForUpdate() {
      try {
        const { fetchLatestRelease, findInstallDir, readInstalled } = await import("./update");
        const { compareVersions } = await import("../shared/update");

        const installDir = await findInstallDir();
        if (!installDir) return null;

        const [installed, release] = await Promise.all([
          readInstalled(installDir),
          fetchLatestRelease(),
        ]);
        if (!release) return null;

        // The published version lives in the archive, which is not fetched
        // here; the asset name carries it too, and that is enough to notice.
        const fromName = /-(\d+\.\d+\.\d+)\.zip$/i.exec(release.assetName)?.[1] ?? null;
        const newer = compareVersions(fromName, installed.version);
        if (newer !== 1) return null;

        return {
          version: fromName,
          name: release.name,
          notes: release.notes,
          htmlUrl: release.htmlUrl,
          publishedAt: release.publishedAt,
        };
      } catch {
        return null;
      }
    },

    openDaily: () => workspace.openDaily(),

    createConcept: ({ path, type, title, description, tags, body }) =>
      workspace.writeFile(
        path,
        skeletonConcept({
          type,
          ...(title ? { title } : {}),
          ...(description ? { description } : {}),
          ...(tags ? { tags } : {}),
          ...(body ? { body } : {}),
          generatedBy: "human:local",
        }),
        { actor: "human:local", action: "create" }
      ),

    search: ({ query, limit, type, tags, pathPrefix }) =>
      workspace.search(query, {
        limit: limit ?? 20,
        ...(type ? { type } : {}),
        ...(tags?.length ? { tags } : {}),
        ...(pathPrefix ? { pathPrefix } : {}),
      }),

    resolveLink: ({ from, target }) => workspace.resolveLink(from, target),

    movePath: ({ from, to }) => workspace.move(from, to, "human:local", "human"),

    promotePath: ({ from, to, keepSource }) =>
      workspace.promote(from, to, {
        actor: "human:local",
        ...(keepSource === undefined ? {} : { keepSource }),
      }),

    deletePath: ({ path }) => workspace.delete(path),

    createDirectory: ({ path }) => workspace.createDirectory(path),

    listConcepts: () => workspace.listConcepts(),

    listTags: () => ({ tags: workspace.tags(), types: workspace.types() }),

    unresolvedLinks: () => workspace.unresolvedLinks(),

    /**
     * Hand a link to the OS browser.
     *
     * Scheme-checked here rather than in the view: the view renders untrusted
     * note content, so this is the last point where a `file:` or custom-scheme
     * URL can still be turned into a local action.
     */
    openExternal: ({ url }) => {
      if (!/^https?:\/\//i.test(url)) return false;
      return platform.openExternal(url);
    },

    rebuildIndex: () => workspace.rebuildIndex(),

    rebuildRag: () => workspace.rebuildRag(),

    checkConformance: () => workspace.conformanceIssues(),

    // ---- external MCP servers ----

    listConnections: () => connections.status(),

    connectServer: ({ id }) => connections.connect(id),

    disconnectServer: ({ id }) => connections.disconnect(id),

    listRemoteTools: ({ id }) => connections.listTools(id),

    /**
     * Capture a remote tool's output into `raw/`.
     *
     * Imports land in Layer 1 only: this is the ingest step, and third-party
     * text has not been curated into knowledge yet.
     */
    async importFromServer({ id, tool, args, title }) {
      const result = await connections.importFromTool(workspace.requireBundle(), {
        serverId: id,
        tool,
        args,
        ...(title ? { title } : {}),
      });
      await workspace.reloadBundle();
      return result;
    },

    async addServerPreset({ preset }) {
      const found = SERVER_PRESETS.find((p) => p.id === preset);
      if (!found) throw new Error(messages.mcpUnknownServer(preset));
      const { note, ...server } = found;
      await upsertServer(server);
      await connections.refresh();
      return { servers: await connections.status(), note };
    },

    openServerConfig: () => registryPath(),

    // ---- SkillSpace ----

    listSkills: () => workspace.requireSkills().summaries(),

    findSkill: ({ task, limit }) => workspace.requireSkills().find(task, limit ?? 3),

    /** Bundle-relative path of a skill's SKILL.md, so the editor can open it. */
    openSkillFile: ({ name }) => workspace.requireSkills().relPathOf(name),

    listSkillCategories: () => workspace.requireSkills().categories(),

    /**
     * Create a skill from the panel.
     *
     * The body is a template rather than empty: a skill with no procedure is
     * worse than no skill, because it still costs a description in every
     * agent's context while giving nothing back when opened.
     */
    async createSkill({ name, description, when, category }) {
      const path = workspace.requireSkills().newSkillPath(name, category ?? "");
      await workspace.writeFile(
        path,
        serializeSkill({
          name,
          description,
          ...(when?.length ? { when } : {}),
          body: [
            `# ${name}`,
            "",
            "## いつ使うか",
            "",
            "（このスキルが適する状況を書いてください）",
            "",
            "## 手順",
            "",
            "1. read_agents_md でバンドルの規約を確認する",
            "2. search で既存の関連ページを探す",
            "3. （ここに手順を書いてください）",
          ].join("\n"),
        }),
        { actor: "human:local", action: "create" }
      );
      workspace.requireSkills().invalidate();
      return { path };
    },

    // ---- one-touch connection to other runtimes ----

    async listConnectTargets() {
      const bundleRoot = workspace.isOpen ? workspace.requireBundle().root : "";
      return Promise.all(
        CONNECT_TARGETS.map(async (target) => {
          const configPath = target.configPath(bundleRoot);
          return {
            id: target.id,
            label: target.label,
            kind: target.kind,
            configPath,
            installed: await isInstalled(target),
            note: target.note,
            ...(target.endpoint ? { endpoint: target.endpoint } : {}),
            ...(target.setupCommand
              ? {
                  setupCommand: target.setupCommand(
                    bundleRoot,
                    serverCommandLine(PROJECT_ROOT, bundleRoot)
                  ),
                }
              : {}),
            // For hosts, "connected" means our entry is already in their file.
            connected:
              target.kind === "mcp-host"
                ? (await readFile(configPath, "utf8").catch(() => "")).includes("okf-wiki")
                : false,
          };
        })
      );
    },

    previewConnect: ({ id }) =>
      previewTarget({
        targetId: id,
        projectRoot: PROJECT_ROOT,
        bundleRoot: workspace.requireBundle().root,
      }),

    applyConnect: ({ id }) =>
      connectTarget({
        targetId: id,
        projectRoot: PROJECT_ROOT,
        bundleRoot: workspace.requireBundle().root,
      }),

    connectAllTargets: ({ includeMissing }) =>
      connectAllTargets({
        projectRoot: PROJECT_ROOT,
        bundleRoot: workspace.requireBundle().root,
        ...(includeMissing ? { includeMissing } : {}),
      }),

    // ---- the built-in agent ----

    listLocalModels: ({ id }) => {
      const target = findTarget(id);
      return new OpenAiCompatClient(target.endpoint ?? "", target.label).listModels();
    },

    runLocalAgent: async ({ id, model, task, maxRounds, tokenBudget }) => {
      const target = findTarget(id);
      const agent = new LocalAgent(
        workspace,
        new OpenAiCompatClient(target.endpoint ?? "", target.label),
        target.label
      );
      await agent.check(model);
      return agent.run({
        task,
        model,
        ...(maxRounds ? { maxRounds } : {}),
        ...(tokenBudget ? { tokenBudget } : {}),
        onStep,
      });
    },
  };
}
