/**
 * MCP tool surface.
 *
 * These tools are the agent-facing half of the symmetry principle: every one
 * of them goes through `Workspace`, so an agent write is subject to the same
 * layer rules, logging and indexing as a keystroke in the editor.
 */

import type { SearchFilters } from "../../shared/types";
import { messages } from "../../shared/messages";
import { PARA_LABELS, PARA_ORDER, paraOf, parseParaClass } from "../../shared/okf/para";
import { parseLifecycle } from "../../shared/okf/lifecycle";
import { isBasePath } from "../../shared/okf/base";
import { isCanvasPath } from "../../shared/okf/canvas";
import { MAX_GRAPH_NODES } from "../../shared/okf/canvas-graph";
import { MAX_CANVAS_EDGES } from "../../shared/okf/canvas";
import type { Task, TaskStatus } from "../../shared/okf/workspace-files";
import type { Workspace } from "../workspace";
import { isConceptPath, splitFrontmatter } from "../../shared/okf";
import { skeletonConcept } from "../okf/parser";
import { formatRetrieval } from "../rag/retrieve";
import { formatContextPack, type ContextTier } from "../rag/context-pack";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const text = (body: string): ToolResult => ({ content: [{ type: "text", text: body }] });
const fail = (body: string): ToolResult => ({
  content: [{ type: "text", text: body }],
  isError: true,
});
const json = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));

// Parameters shared by retrieve, context_pack and search.
const INCLUDE_DEAD = {
  type: "boolean",
  description: "Also return concepts tagged DEAD, which are left out by default (default false)",
};
const PARA_DEPTH = {
  type: "number",
  description:
    "Only read PARA classes up to this priority, 1-4: 1 projects, 2 +areas, 3 +resources (unfiled concepts and know-how count here), 4 everything (default)",
};
const LINK_DEPTH = {
  type: "number",
  description:
    "After retrieval, follow links from the returned files up to 0-2 hops and list those files' one-line descriptions (never bodies) within the same budget (default 0)",
};

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "read_map",
    title: "Read MAP.md",
    description:
      "Read MAP.md — the routing table for this bundle. Call this FIRST. It is small and tells you which single file or tool answers each kind of question (who the user is, what the current tasks are, where knowledge lives, what may be written where), so you can go straight to that one place instead of reading around to find it.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_human",
    title: "Read human.md",
    description:
      "Read human.md — who the user is: how to address them, how they want work done, their constraints and current context. Read this before doing substantial work for them. Creates the file from a template when it does not exist yet.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "write_human",
    title: "Write human.md",
    description:
      "Replace human.md. Use when the user tells you something durable about themselves or how they want to be worked with. Keep it short — this file is read on every session, so length is a recurring cost.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The full new contents of human.md" },
      },
      required: ["content"],
    },
  },
  {
    name: "list_tasks",
    title: "List tasks",
    description:
      "List tasks from Task.md. Returns only OPEN work (in progress, then not started) unless a status is given — the completed history is the bulk of the file and is rarely what you want. Read this to find out what to work on.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Restrict to one status: doing | todo | done. Omit for all open work.",
        },
      },
    },
  },
  {
    name: "daily_note",
    title: "Open today's note",
    description:
      "Get today's daily note (wiki/daily/YYYY-MM-DD.md), creating it from the template if it does not exist. Use this to record what happened today, or to read what the user wrote there.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "ISO date, e.g. 2026-08-04. Defaults to today." },
      },
    },
  },
  {
    name: "collect_daily_tasks",
    title: "Move daily-note tasks into Task.md",
    description:
      "Read today's daily note, take every UNCHECKED item under the '## タスク' heading, add each to Task.md, then tick the line and stamp it with the task id. Call this whenever you have read a daily note that contains work the user wants tracked — a requirement left in a daily note is invisible tomorrow, because Task.md is the list that gets read. Safe to call twice: ticked lines are never carried over again.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "ISO date. Defaults to today." },
      },
    },
  },
  {
    name: "add_task",
    title: "Add a task",
    description:
      "Add a task to Task.md. Use when the user asks for something that will not be finished in this exchange, or when you find work that needs doing later.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "What needs doing, in one line" },
        status: { type: "string", description: "doing | todo (default todo)" },
        para: { type: "string", description: "project | area | resource | archive" },
        due: { type: "string", description: "ISO date, e.g. 2026-08-31" },
        note: { type: "string", description: "One line of detail" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task",
    title: "Update a task",
    description:
      "Change a task's status or fields by id (e.g. T-0007). Completing one stamps today's date. Call this when you finish something rather than leaving the list stale.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task id, e.g. T-0007" },
        status: { type: "string", description: "doing | todo | done" },
        title: { type: "string" },
        para: { type: "string", description: "project | area | resource | archive" },
        due: { type: "string", description: "ISO date" },
        note: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "read_agents_md",
    title: "Read AGENTS.md",
    description:
      "Read AGENTS.md (wiki/AGENTS.md): the layer contract, the OKF frontmatter rules and the naming conventions this bundle expects. Read MAP.md first — it will tell you whether you need this.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "open_bundle",
    title: "Open bundle",
    description:
      "Open a local directory as an OKF knowledge bundle. Not needed when the server was started with OKF_BUNDLE set.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the bundle root" },
      },
      required: ["path"],
    },
  },
  {
    name: "bundle_info",
    title: "Bundle info",
    description:
      "Summarise the open bundle: root, wiki directory, concept count and how many concepts fail OKF conformance.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_files",
    title: "List files",
    description: "List files and directories, annotated with the LLM Wiki layer they belong to.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Bundle-relative path; omit for the root" },
        recursive: { type: "boolean", description: "Recurse into subdirectories" },
      },
    },
  },
  {
    name: "retrieve",
    title: "Retrieve context",
    description:
      "Retrieve relevant passages assembled for reasoning, with citation anchors and a character budget. This is the RAG entry point — prefer it over search when you need to ANSWER a question from the knowledge base. Returns whole sections with their heading path, not just snippets. Works with Japanese and English.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language question or keywords" },
        limit: { type: "number", description: "Maximum passages (default 8)" },
        budget_chars: {
          type: "number",
          description: "Character budget across all passages (default 6000)",
        },
        expand_neighbours: {
          type: "boolean",
          description: "Include adjacent sections for continuity (default false)",
        },
        type: { type: "string", description: "Restrict to one OKF type" },
        tags: { type: "array", items: { type: "string" }, description: "Require all these tags" },
        path_prefix: { type: "string", description: "Restrict to a bundle-relative path prefix" },
        include_dead: INCLUDE_DEAD,
        para_depth: PARA_DEPTH,
        link_depth: LINK_DEPTH,
      },
      required: ["query"],
    },
  },
  {
    name: "context_pack",
    title: "Build a context pack",
    description:
      "Assemble the MINIMAL set of files needed to start a task — relevant passages grouped by file, each file's one-line description, and the skills that match the task — within a character budget. Call this at the START of substantial work instead of reading files one by one. tier='worker' returns a small pack for a cheap or local model doing delegated work; tier='supervisor' returns a broader pack for a frontier model planning or verifying. Omit tier for a middle default. The pack also lists the best-matching know-how (lessons other agents recorded) and, with link_depth, one-line pointers to files linked from the ones above.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the work is, in natural language" },
        tier: {
          type: "string",
          description: "worker | supervisor — sizes the pack to the consuming model",
        },
        budget_chars: {
          type: "number",
          description: "Character budget across all passages (overrides the tier default)",
        },
        limit: { type: "number", description: "Maximum passages before grouping" },
        type: { type: "string", description: "Restrict to one OKF type" },
        tags: { type: "array", items: { type: "string" }, description: "Require all these tags" },
        path_prefix: { type: "string", description: "Restrict to a bundle-relative path prefix" },
        include_dead: INCLUDE_DEAD,
        para_depth: PARA_DEPTH,
        link_depth: LINK_DEPTH,
      },
      required: ["task"],
    },
  },
  {
    name: "search",
    title: "Search",
    description:
      "BM25 full-text search across wiki concepts, returning one hit per document. Use this to LOCATE pages (and to check whether knowledge already exists before writing). To answer a question from the content, use retrieve instead. Handles Japanese via bigram indexing. Concepts tagged DEAD are left out unless include_dead is true (to list them: tags ['DEAD'] with include_dead).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Maximum hits (default 20)" },
        type: { type: "string", description: "Restrict to one OKF type" },
        tags: { type: "array", items: { type: "string" }, description: "Require all these tags" },
        path_prefix: { type: "string", description: "Restrict to a bundle-relative path prefix" },
        include_dead: INCLUDE_DEAD,
      },
      required: ["query"],
    },
  },
  {
    name: "list_concepts",
    title: "List concepts",
    description:
      "Every concept id with its title and type, plus its lifecycle when marked (product | dead). Use to get an overview of the bundle, or to find the exact id for a link. DEAD concepts are listed here too: this is the inventory.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_tags",
    title: "List tags and types",
    description: "Tag and OKF type counts across the bundle, for filtering and for orientation.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "unresolved_links",
    title: "Unresolved links",
    description:
      "Wikilinks pointing at concepts that do not exist yet. These are the knowledge gaps the bundle has already identified — good candidates for new pages.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    title: "Read file",
    description:
      "Read a file relative to the bundle root. For concept documents the response also carries parsed frontmatter, outbound links and backlinks.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "e.g. wiki/topic/thing.md" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    title: "Write file",
    description:
      "Write a file relative to the bundle root. Concept documents must carry YAML frontmatter with a non-empty 'type' (OKF v0.2); non-conformance is reported back as a warning. Writing into raw/ or .rag/ is rejected. A log.md row is appended automatically.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        actor: {
          type: "string",
          description: "Actor for the log row, e.g. process:claude-code",
        },
        note: { type: "string", description: "Optional note for the log row" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "create_concept",
    title: "Create concept",
    description:
      "Create a new OKF-conformant concept document with correct frontmatter. Prefer this over write_file for new pages — it cannot produce a non-conformant file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Bundle-relative path ending in .md" },
        type: { type: "string", description: "OKF type, e.g. Concept, Entity, Playbook" },
        title: { type: "string" },
        description: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        body: { type: "string", description: "Markdown body below the heading" },
        actor: { type: "string", description: "Actor recorded in generated.by" },
      },
      required: ["path", "type"],
    },
  },
  {
    name: "backlinks",
    title: "Backlinks",
    description: "List concepts linking to the given concept id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Concept id (path without .md)" } },
      required: ["id"],
    },
  },
  {
    name: "move_file",
    title: "Move or rename",
    description:
      "Move or rename a file within wiki/ or .rag/, rewriting every link that pointed at it (body links and the frontmatter relations entries, edited in place) so the graph stays intact; a relation it cannot edit safely is listed in the answer as dangling. Always prefer this over write_file + delete_file, which would silently break inbound links. Files in raw/ cannot be moved by an agent: promoting unreviewed material into the canonical layer is a human decision, so ask the user to do it from the UI.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Current bundle-relative path" },
        to: { type: "string", description: "New bundle-relative path" },
        actor: { type: "string" },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "delete_file",
    title: "Delete",
    description:
      "Delete a file. Reports which concepts had links to it, since those links become broken. Reserved files cannot be deleted.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        actor: { type: "string" },
      },
      required: ["path"],
    },
  },
  {
    name: "create_directory",
    title: "Create directory",
    description: "Create a directory inside the bundle.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "check_conformance",
    title: "Check conformance",
    description:
      "Report every document that violates OKF v0.2 §11 — missing frontmatter, missing 'type', or frontmatter on a reserved file. Schema warnings (undeclared concept types and relation kinds) are not violations and are reported by graph_schema.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "audit_changes",
    title: "Audit changes",
    description:
      "Group log.md rows by actor to see who — the human, or which model — changed what, optionally since an ISO date. Use it to review agent-written changes before trusting them, and after several models have worked on the same bundle. Rows are returned newest first.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO date; only rows on or after it" },
        actor: {
          type: "string",
          description: "Substring filter on the actor, e.g. 'process:' for all agents",
        },
      },
    },
  },
  {
    name: "summarize_activity",
    title: "Summarize activity",
    description:
      "Summarize what changed in the bundle as a page you can cite: log.md rows grouped by actor, then by file, each line giving the log date and the bundle-relative path it came from, plus totals per action. Nothing is inferred beyond the log. Filter by ISO dates and an actor substring. With save: true it is also written as an ActivitySummary concept at wiki/activity/<since>_<until>[_<actor>].md (credited to 'by', or process:okf; a filter that does not survive as a file name gets a short hash appended so two filters never share a file) and the path is returned instead of the page.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "ISO date; only rows on or after it" },
        until: { type: "string", description: "ISO date; only rows on or before it" },
        actor: {
          type: "string",
          description: "Substring filter on the actor, e.g. 'process:codex'. Only narrows the rows; it does not say who saves the summary.",
        },
        by: {
          type: "string",
          description: "Who is running this, e.g. 'process:claude-code'; credits a saved summary (default process:okf)",
        },
        save: {
          type: "boolean",
          description: "Write the summary into wiki/activity/ and return its path (default false)",
        },
      },
    },
  },
  {
    name: "rebuild_index",
    title: "Rebuild index.md",
    description: "Regenerate index.md from all concepts currently on disk.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rebuild_rag",
    title: "Rebuild search index",
    description: "Rebuild the .rag FTS5 index from scratch.",
    inputSchema: { type: "object", properties: {} },
  },

  // ---- SkillSpace ----
  //
  // Three tools, three tiers, in deliberate order of cost. The descriptions
  // say so explicitly: an agent that knows `skill_find` is free will reach for
  // it before `skill_open`, which is the entire point of the layer.
  {
    name: "skill_find",
    title: "Find a skill",
    description:
      "Find which skill fits a task. CHEAP — ranks locally and returns only names, descriptions and scores, never a procedure body. Call this FIRST whenever a task might have an established procedure, then call skill_open on the winner. If confidence is 'low', compare the returned descriptions before opening one.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the user is trying to do, in their own words." },
        limit: { type: "number", description: "Candidates to return. Default 3." },
      },
      required: ["task"],
    },
  },
  {
    name: "skill_list",
    title: "List skills",
    description:
      "List every skill: name, description, tags, and the token cost of opening each. CHEAP — no procedure bodies. Prefer skill_find when you have a specific task; use this to see what the bundle can do.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "skill_open",
    title: "Open a skill",
    description:
      "Load a skill's full procedure. COSTS TOKENS — call it once, for the one skill you actually need, after skill_find. Returns the body plus the names of any supporting files, which you then read individually with skill_read.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Skill name from skill_find or skill_list." } },
      required: ["name"],
    },
  },
  {
    name: "skill_read",
    title: "Read a skill resource",
    description:
      "Read one supporting file from inside a skill folder. Only call this for a file the opened skill actually pointed you at — reading them speculatively defeats the purpose of keeping them out of the body.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name." },
        path: { type: "string", description: "Resource path, relative to the skill folder." },
      },
      required: ["name", "path"],
    },
  },

  // ---- PARA ----
  {
    name: "set_para",
    title: "Refile under PARA",
    description:
      "Move a concept into one of the four PARA folders: project (in progress, has an end), area (no deadline but deliberately prioritised), resource (useful knowledge), archive (not in use). This is a real move, so links are rewritten. Use archive rather than delete when something stops being current — archived notes stay findable but rank far below everything else.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Bundle-relative path of the concept." },
        para: {
          type: "string",
          description: "project | area | resource | archive",
        },
      },
      required: ["path", "para"],
    },
  },
  {
    name: "list_para",
    title: "List by PARA",
    description:
      "Every concept grouped by PARA class, in priority order. Use it to see what is actually active before deciding what to work on, or to find stale notes that belong in the archive.",
    inputSchema: {
      type: "object",
      properties: {
        para: { type: "string", description: "Restrict to one class. Omit for all." },
      },
    },
  },

  {
    name: "set_lifecycle",
    title: "Mark Product or DEAD",
    description:
      "Mark a concept's lifecycle with a frontmatter tag: 'product' (a finished, trusted result - ranks slightly higher), 'dead' (retired - left out of search, retrieve and context_pack unless include_dead is true; NOT deleted, links and history stay), or 'none' to clear. A concept is never both. To list retired files: search with tags ['DEAD'] and include_dead true.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Bundle-relative path of the concept." },
        lifecycle: { type: "string", description: "product | dead | none" },
        actor: { type: "string", description: "Who is making the change, e.g. process:claude-code." },
      },
      required: ["path", "lifecycle"],
    },
  },

  // ---- know-how ----
  //
  // Lighter than a skill: one lesson, found by title. Recorded under
  // wiki/knowhow/ so every agent reads the same notes.
  {
    name: "knowhow_find",
    title: "Find know-how",
    description:
      "Find lessons other agents recorded that fit a task: pitfalls, conventions, 'this worked'. CHEAP — returns titles, descriptions, scores and who recorded each, never the body (read_file the ones that apply). Call this before starting work; context_pack already includes the top three.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "What you are about to do, in natural language." },
        limit: { type: "number", description: "Candidates to return, 1-20. Default 3." },
      },
      required: ["task"],
    },
  },
  {
    name: "knowhow_add",
    title: "Record know-how",
    description:
      "Record one short lesson for the agents that come after you, after a non-obvious discovery: a pitfall, a convention, something that worked. One lesson per call, written so it makes sense without this conversation. Stored in wiki/knowhow/ with who recorded it. Lighter than a skill — if it is a full procedure, write a skill instead.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The lesson in a few words." },
        body: { type: "string", description: "What happened and what to do about it. Start with the one-line takeaway." },
        tags: { type: "array", items: { type: "string" }, description: "Topics, for filtering" },
        actor: { type: "string", description: "Which agent is recording this, e.g. process:claude-code or process:codex." },
      },
      required: ["title", "body", "actor"],
    },
  },

  // ---- bases ----
  //
  // List and aggregate views over the concepts, in the format Obsidian Bases
  // reads. Querying one is cheaper and more exact than reading many files.
  {
    name: "base_list",
    title: "List bases",
    description:
      "List the .base files in wiki/ with the views each offers (name and type). A base is a saved list or aggregate over the concepts - for example 'every Product by PARA, with counts'. Check here before scanning many files to answer a list or count question: if a base already answers it, base_query returns the rows directly.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "base_query",
    title: "Query a base",
    description:
      "Run one view of a .base file over the concepts and return JSON (columns, rows or groups, summaries, warnings) plus a compact Markdown table in 'markdown'. Rows are ordered deterministically and capped at 500. Use this instead of reading many files for lists, counts and aggregates (e.g. all Product concepts per PARA class). Supports table and cards views; formulas, sorting, grouping and summaries are evaluated for you.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Bundle-relative path of the .base file, e.g. wiki/bases/products-and-dead.base." },
        view: { type: "string", description: "View name (see base_list). Defaults to the first view." },
        limit: { type: "number", description: "Return at most this many rows (a positive integer; the view's own limit still applies)." },
      },
      required: ["path"],
    },
  },
  {
    name: "base_write",
    title: "Write a base",
    description:
      "Create or replace a .base file under wiki/. The YAML and the supported subset are checked first and nothing is written if they are invalid; the text is saved exactly as given, so keys this app does not use survive. Format (Obsidian Bases): top-level filters (a string expression, or and/or/not lists), formulas, properties (displayName), summaries, and views of type table or cards with name, filters, order, sort ([{property, direction}]), limit, groupBy ({property, direction}) and summaries ({property: Sum}). File properties: file.name, basename, path, folder, ext, mtime, tags, links, properties, plus file.para; file.hasTag(), file.inFolder(), file.hasLink() work. Frontmatter keys are bare names or note.NAME; formulas are formula.NAME. Create a base when you expect to ask the same list or count question again.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Bundle-relative path ending in .base, under wiki/, e.g. wiki/bases/open-projects.base." },
        content: { type: "string", description: "The full YAML text of the base." },
        actor: { type: "string", description: "Who is writing, e.g. process:claude-code." },
      },
      required: ["path", "content"],
    },
  },

  // ---- canvases and the graph ----
  //
  // Relationship diagrams in the JSON Canvas format Obsidian reads, and the
  // schema that says which concept types and relation kinds the bundle uses.
  {
    name: "canvas_list",
    title: "List canvases",
    description:
      "List the .canvas files under wiki/ (JSON Canvas 1.0, as Obsidian reads it) with their node and edge counts. A canvas is a relationship diagram: file nodes pointing at concepts, text, link and group nodes, and edges between them. Check here before drawing a new one.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "canvas_read",
    title: "Read a canvas",
    description:
      "Read one .canvas file as structured JSON ('canvas': nodes and edges exactly as stored) plus a compact text 'outline': nodes by group with file nodes resolved to the concept's title and description, then the edges with their labels. Read the outline to understand a diagram without rendering it.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Bundle-relative path of the .canvas file, e.g. wiki/graph/canvases/overview.canvas." },
      },
      required: ["path"],
    },
  },
  {
    name: "canvas_write",
    title: "Write a canvas",
    description:
      "Create or replace a .canvas file under wiki/ (not in a hidden folder). The JSON is checked against the JSON Canvas 1.0 spec first (node types text, file, link and group; integer x, y, width and height; edges between existing node ids; sides top/right/bottom/left; ends none/arrow; colours '1'-'6' or #hex) and within bounds (1 MiB, 2000 nodes, 5000 edges, 32 levels deep); nothing is written if it is invalid. The text is saved exactly as given, so unknown keys and the order of nodes and edges survive a round trip with Obsidian. A file node's 'file' is a bundle-relative path such as wiki/3-resources/foo.md.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Bundle-relative path ending in .canvas, under wiki/, e.g. wiki/graph/canvases/overview.canvas." },
        content: { type: "string", description: "The full JSON text of the canvas." },
        actor: { type: "string", description: "Who is writing, e.g. process:claude-code." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "canvas_from_links",
    title: "Draw concept relationships",
    description:
      "Draw the neighbourhood of a concept (root) or of what a retrieval query finds (query, its top 5 hits) as a canvas, following wiki links, Markdown links and typed relations in both directions up to depth steps (0-3, default 1), and save it. Layout is deterministic: a column per distance from the root, concepts ordered by path, fixed sizes; plain links are unlabeled, typed relations carry their kind; roots are green, DEAD concepts red. Links to missing concepts and self-links are not drawn. At most 150 concepts and 5000 edges are drawn. Refuses to replace an existing canvas unless overwrite is true. Returns where it was saved and the text outline.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "The concept to centre on: its id (topics/foo), its path (wiki/topics/foo.md) or a unique bare name." },
        query: { type: "string", description: "Instead of (or as well as) root: a search query whose best hits are the centre." },
        depth: { type: "number", description: "How many link steps out to follow, 0-3 (default 1)." },
        include_dead: INCLUDE_DEAD,
        para_depth: PARA_DEPTH,
        group_by_para: { type: "boolean", description: "Frame concepts of the same PARA class in each column with a group node (default false)." },
        path: { type: "string", description: "Where to save, ending in .canvas (under wiki/). A bare file name goes in wiki/graph/canvases/." },
        overwrite: { type: "boolean", description: "Replace a canvas that already exists at path (default false: refuse, so a hand-made canvas is not lost)." },
        actor: { type: "string", description: "Who is writing, e.g. process:claude-code." },
      },
      required: ["path"],
    },
  },
  {
    name: "graph_schema",
    title: "Read the graph schema",
    description:
      "Read wiki/graph/schema.md parsed: the concept 'types' and relation 'kinds' (name, description, optional from/to types) this bundle declares. Concepts declare typed relations in their frontmatter as relations: {kind: [path or [[link]], ...]}; its 'warnings' lists concept types and relation kinds not declared here (never violations). If 'exists' is false the bundle has no schema and nothing is checked.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "system_map",
    title: "Read SYSTEMMAP.md",
    description:
      "Read SYSTEMMAP.md, the map of the system itself: layers, folders, tool groups, where bases, canvases, skills, loops, know-how and the graph live, and how to extend each. Between its markers is an auto-generated section with the current counts and listings (concepts per PARA and type, bases, canvases, skills, loops, know-how, schema types and kinds, tool count). With refresh true, that section alone is regenerated and saved (text outside the markers is never touched; a bundle without the file gets it). Refresh after adding types, relation kinds, bases, canvases, skills or loops.",
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean", description: "Regenerate and save the auto-generated section (default false: just read)." },
        actor: { type: "string", description: "Who is refreshing, e.g. process:claude-code." },
      },
    },
  },

  // ---- loops ----
  //
  // The before/after bookends. `loop_start` is deliberately the single call an
  // agent needs to begin correctly: it snapshots the bundle AND returns the
  // matching skills, so there is no sequence to remember.
  {
    name: "loop_define",
    title: "Define a loop",
    description:
      "Create or update a loop design — a repeatable unit of work such as 'ingest meeting notes' or 'weekly lint'. One design is one file under loops/, and every run of it appends to that same file. Updating a design never rewrites its run history.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "What this loop accomplishes, every time it runs." },
        name: { type: "string", description: "Loop name (lowercase, digits, hyphens). Derived from the goal if omitted." },
        skill: { type: "string", description: "Skill to follow on each run." },
        checks: {
          type: "array",
          items: { type: "string" },
          description: "What must be true before a run is finished. Returned again by loop_end.",
        },
      },
      required: ["goal"],
    },
  },
  {
    name: "loop_start",
    title: "Start a run",
    description:
      "BEGIN HERE for any task that will change the bundle. Starts a run of an existing loop design: snapshots the bundle, returns the design's skill and completion checks, and tells you how the last run went. Only one run may be in progress at a time — close the previous one with loop_end first. Pass a goal to define the loop on the spot when it does not exist yet.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Loop name from loop_list." },
        goal: { type: "string", description: "Used to create the design if it does not exist yet." },
        actor: { type: "string", description: "Who is working, e.g. process:claude-code." },
      },
    },
  },
  {
    name: "loop_note",
    title: "Note a step",
    description:
      "Append a line to the running run's journal. File writes, moves and deletes are journalled automatically — use this for decisions and findings that leave no other trace, e.g. why an approach was rejected.",
    inputSchema: {
      type: "object",
      properties: {
        detail: { type: "string", description: "What happened, in one line." },
        action: { type: "string", description: "Short label. Defaults to 'note'." },
      },
      required: ["detail"],
    },
  },
  {
    name: "loop_end",
    title: "End the run",
    description:
      "FINISH HERE. Snapshots the bundle again, reports what changed against the preflight, and closes the run in its design's file. Returns the design's completion checks so they can be confirmed. Flags a rise in OKF non-conformance as a regression — fix it rather than leaving the run closed on a worse bundle.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: { type: "string", description: "What was accomplished, and what is left." },
        status: {
          type: "string",
          description: "'done' (default) or 'abandoned' when the work was not completed.",
        },
      },
    },
  },
  {
    name: "loop_list",
    title: "List loops",
    description:
      "Every loop design with its goal, skill, run count and how the last run went. Also reports which run is in progress, if any. Call this when resuming work.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "loop_read",
    title: "Read a loop",
    description:
      "One loop design in full: its goal, completion checks, and run history. Use it to see how this work went before.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Loop name from loop_list." } },
      required: ["name"],
    },
  },
];

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value : "";
}

function strArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * An optional ISO date argument.
 *
 * Three outcomes, kept apart because they mean different things: `undefined`
 * for "not given, use today", a `Date` for a valid one, and `null` for a value
 * that was supplied but is not a date — silently treating that as today would
 * write into the wrong day's note.
 */
function parseDate(value: string): Date | undefined | null {
  if (!value.trim()) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;

  // Parsed as local midnight: a daily note is named for a local day, and
  // `new Date("2026-08-04")` is UTC, which lands on the previous day west of
  // Greenwich.
  const [y, m, d] = value.trim().split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  // The constructor normalises overflow (2026-02-30 → March 2nd) instead of
  // failing; comparing the components back catches exactly that.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

const TASK_STATUSES: readonly TaskStatus[] = ["doing", "todo", "done"];

const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  doing: "進行中",
  todo: "未着手",
  done: "完了",
};

/** One task on one line, which is all a caller needs to pick or refer to it. */
function describeTask(task: Task): string {
  const parts = [`${task.id} [${TASK_STATUS_LABEL[task.status]}] ${task.title}`];
  if (task.para) parts.push(task.para);
  if (task.due) parts.push(`期限 ${task.due}`);
  if (task.done) parts.push(`完了 ${task.done}`);
  if (task.note) parts.push(task.note);
  return parts.join(" · ");
}

/**
 * Whether a concept document records who generated it.
 *
 * Cheap on purpose: a top-level `generated:` key in the frontmatter is taken
 * at its word. The point is a nudge on every agent write, not a validation.
 */
function lacksProvenance(content: string): boolean {
  const { yaml } = splitFrontmatter(content);
  return yaml === null || !/^generated[ \t]*:/m.test(yaml);
}

/** Pull the shared search/retrieve filters out of a tool argument object. */
function filtersFrom(args: Record<string, unknown>): SearchFilters {
  const filters: SearchFilters = {};
  const type = str(args, "type");
  if (type) filters.type = type;
  const tags = strArray(args, "tags");
  if (tags.length) filters.tags = tags;
  const pathPrefix = str(args, "path_prefix");
  if (pathPrefix) filters.pathPrefix = pathPrefix;
  if (args.include_dead === true) filters.includeDead = true;
  return filters;
}

/**
 * `para_depth` and `link_depth`, validated, or the message to fail with.
 *
 * Rejected rather than clamped: a depth is a scope the caller chose on
 * purpose, and silently reading a different scope than the one asked for would
 * return an answer to another question.
 */
function rangeFrom(args: Record<string, unknown>): { paraDepth?: number; linkDepth?: number } | string {
  const out: { paraDepth?: number; linkDepth?: number } = {};
  const check = (key: string, min: number, max: number): number | string | undefined => {
    const value = args[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      return `${key} must be an integer from ${min} to ${max}: ${String(value)}`;
    }
    return value;
  };

  const para = check("para_depth", 1, 4);
  if (typeof para === "string") return para;
  if (para !== undefined) out.paraDepth = para;

  const link = check("link_depth", 0, 2);
  if (typeof link === "string") return link;
  if (link !== undefined) out.linkDepth = link;
  return out;
}

/**
 * `depth` (0-3) and `para_depth` (1-4) for `canvas_from_links`, validated, or
 * the message to fail with. Rejected rather than clamped, like `rangeFrom`.
 */
function canvasRangeFrom(args: Record<string, unknown>): { depth?: number; paraDepth?: number } | string {
  const out: { depth?: number; paraDepth?: number } = {};
  for (const [key, min, max] of [["depth", 0, 3], ["para_depth", 1, 4]] as const) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      return `${key} must be an integer from ${min} to ${max}: ${String(value)}`;
    }
    if (key === "depth") out.depth = value;
    else out.paraDepth = value;
  }
  return out;
}

/** The relations a move could not follow, for the end of its answer. */
function danglingNote(dangling: ReadonlyArray<{ path: string; kind: string; target: string }>): string {
  if (dangling.length === 0) return "";
  const list = dangling.map((d) => `${d.path} (${d.kind}: ${d.target})`).join("; ");
  return ` — these relations now dangle and need a manual edit: ${list}`;
}

export async function callTool(
  workspace: Workspace,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    switch (name) {
      case "read_map":
        return text(await workspace.readMap());

      case "read_human":
        return text(await workspace.ensureHuman());

      case "write_human": {
        const content = String(args.content ?? "");
        if (!content.trim()) return fail("content is empty");
        await workspace.writeHuman(content);
        return text("human.md を更新しました。");
      }

      case "list_tasks": {
        const requested = args.status === undefined ? undefined : String(args.status);
        if (requested && !TASK_STATUSES.includes(requested as TaskStatus)) {
          return fail(`status must be one of: ${TASK_STATUSES.join(", ")}`);
        }

        const tasks = await workspace.listTasks(requested as TaskStatus | undefined);
        if (tasks.length === 0) {
          return text(requested ? `${requested} のタスクはありません。` : "未完了のタスクはありません。");
        }
        return text(tasks.map(describeTask).join("\n"));
      }

      case "daily_note": {
        const date = parseDate(str(args, "date"));
        if (date === null) return fail(`date must be an ISO date: ${args.date}`);

        const { path, created } = await workspace.openDaily(date ?? undefined);
        const file = await workspace.readFile(path);
        return text(
          `${path}${created ? "（新規作成）" : ""}\n\n${file.binary ? "" : file.content}`
        );
      }

      case "collect_daily_tasks": {
        const date = parseDate(str(args, "date"));
        if (date === null) return fail(`date must be an ISO date: ${args.date}`);

        const created = await workspace.collectDailyTasks(date ?? undefined);
        if (created.length === 0) {
          return text("取り込むタスクはありません（未チェックの項目なし）。");
        }
        return text(
          `${created.length} 件を Task.md に取り込みました:\n` +
            created.map(describeTask).join("\n")
        );
      }

      case "add_task": {
        const title = String(args.title ?? "").trim();
        if (!title) return fail("title is required");

        const status = args.status === undefined ? undefined : String(args.status);
        if (status && !TASK_STATUSES.includes(status as TaskStatus)) {
          return fail(`status must be one of: ${TASK_STATUSES.join(", ")}`);
        }

        const para = args.para === undefined ? null : parseParaClass(String(args.para));
        if (args.para !== undefined && !para) return fail(`unknown PARA class: ${args.para}`);

        const task = await workspace.addTask({
          title,
          ...(status ? { status: status as TaskStatus } : {}),
          ...(para ? { para } : {}),
          ...(args.due ? { due: String(args.due) } : {}),
          ...(args.note ? { note: String(args.note) } : {}),
        });
        return text(`追加しました: ${describeTask(task)}`);
      }

      case "update_task": {
        const id = String(args.id ?? "").trim();
        if (!id) return fail("id is required");

        const status = args.status === undefined ? undefined : String(args.status);
        if (status && !TASK_STATUSES.includes(status as TaskStatus)) {
          return fail(`status must be one of: ${TASK_STATUSES.join(", ")}`);
        }

        const para = args.para === undefined ? null : parseParaClass(String(args.para));
        if (args.para !== undefined && !para) return fail(`unknown PARA class: ${args.para}`);

        const task = await workspace.updateTask(id, {
          ...(status ? { status: status as TaskStatus } : {}),
          ...(args.title !== undefined ? { title: String(args.title) } : {}),
          ...(para ? { para } : {}),
          ...(args.due !== undefined ? { due: String(args.due) } : {}),
          ...(args.note !== undefined ? { note: String(args.note) } : {}),
        });

        if (!task) return fail(`no such task: ${id}`);
        return text(`更新しました: ${describeTask(task)}`);
      }

      case "read_agents_md": {
        const content = await workspace.readAgentsMd();
        if (content !== null) return text(content);
        return text(
          "AGENTS.md is missing at the bundle root.\n\n" +
            "This bundle has no agent contract. Follow the OKF v0.2 defaults: every concept " +
            "document needs YAML frontmatter with a non-empty 'type'; index.md and log.md are " +
            "reserved and carry no frontmatter; raw/ is immutable; .rag/ is derived."
        );
      }

      case "open_bundle": {
        const path = str(args, "path");
        if (!path) return fail("'path' is required");
        return json(await workspace.open(path));
      }

      case "bundle_info": {
        const info = await workspace.info();
        return info ? json(info) : fail("No bundle is open. Call open_bundle first.");
      }

      case "list_files":
        return json(await workspace.listDir(str(args, "path"), Boolean(args.recursive)));

      case "retrieve": {
        const query = str(args, "query");
        if (!query) return fail("'query' is required");
        const range = rangeFrom(args);
        if (typeof range === "string") return fail(range);
        const result = workspace.retrieve(query, {
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          ...(typeof args.budget_chars === "number" ? { budgetChars: args.budget_chars } : {}),
          ...(args.expand_neighbours === true ? { expandNeighbours: true } : {}),
          ...filtersFrom(args),
          ...range,
        });
        return text(formatRetrieval(result));
      }

      case "context_pack": {
        const task = str(args, "task");
        if (!task.trim()) return fail("'task' is required");

        const tier = str(args, "tier");
        if (tier && tier !== "worker" && tier !== "supervisor") {
          return fail(`tier must be 'worker' or 'supervisor': ${tier}`);
        }
        const range = rangeFrom(args);
        if (typeof range === "string") return fail(range);

        const pack = await workspace.contextPack(task, {
          ...(tier ? { tier: tier as ContextTier } : {}),
          ...(typeof args.budget_chars === "number" ? { budgetChars: args.budget_chars } : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          ...filtersFrom(args),
          ...range,
        });
        return text(formatContextPack(pack));
      }

      case "search": {
        const query = str(args, "query");
        if (!query) return fail("'query' is required");
        const hits = workspace.search(query, {
          limit: typeof args.limit === "number" ? args.limit : 20,
          ...filtersFrom(args),
        });
        if (hits.length === 0) return text(`No matches for: ${query}`);
        return json(
          hits.map((hit) => ({
            id: hit.id,
            path: hit.path,
            title: hit.title,
            type: hit.type,
            section: hit.headingPath.join(" › ") || undefined,
            snippet: hit.snippet,
          }))
        );
      }

      case "list_concepts":
        return json(workspace.listConcepts());

      case "list_tags":
        return json({ tags: workspace.tags(), types: workspace.types() });

      case "unresolved_links": {
        const gaps = workspace.unresolvedLinks();
        return gaps.length === 0 ? text("No unresolved links.") : json(gaps);
      }

      case "move_file": {
        // Agents may reorganise curated material but cannot promote out of
        // raw/; `assertMovable` enforces that from the actor tag.
        const from = str(args, "from");
        const to = str(args, "to");
        if (!from || !to) return fail("'from' and 'to' are required");
        const result = await workspace.move(
          from,
          to,
          str(args, "actor") || "process:mcp",
          "agent"
        );
        const note = result.linkCount
          ? ` — updated ${result.linkCount} link(s) in ${result.updated.length} file(s)`
          : "";
        return text(`Moved ${from} → ${result.moved}${note}${danglingNote(result.danglingRelations)}`);
      }

      case "delete_file": {
        const path = str(args, "path");
        if (!path) return fail("'path' is required");
        const result = await workspace.delete(path, str(args, "actor") || "process:mcp", "agent");
        if (result.brokenLinksFrom.length === 0) return text(`Deleted ${result.deleted}`);
        return text(
          `Deleted ${result.deleted}. These concepts now have broken links: ` +
            result.brokenLinksFrom.join(", ")
        );
      }

      case "create_directory": {
        const path = str(args, "path");
        if (!path) return fail("'path' is required");
        await workspace.createDirectory(path, "agent");
        return text(`Created directory ${path}`);
      }

      case "read_file": {
        const path = str(args, "path");
        if (!path) return fail("'path' is required");
        const result = await workspace.readFile(path);
        if (!result.concept) return text(result.content);
        return json({
          path,
          id: result.concept.id,
          frontmatter: result.concept.frontmatter,
          links: result.concept.links,
          backlinks: result.backlinks,
          body: result.concept.body,
        });
      }

      case "write_file": {
        const path = str(args, "path");
        if (!path) return fail("'path' is required");
        const content = str(args, "content");
        const result = await workspace.writeFile(path, content, {
          by: "agent",
          actor: str(args, "actor") || "process:mcp",
          note: str(args, "note"),
        });

        // Conformance was checked as part of the write; provenance is checked
        // here because it is a rule for agents, not for the file format — a
        // human editing in the UI is not held to it. skills/ and loops/ hold
        // procedures and journals, not knowledge claims, so they are exempt.
        const warnings = [...result.warnings];
        if (
          isConceptPath(path) &&
          !workspace.requireBundle().paths.isSubsystemPath(path) &&
          lacksProvenance(content)
        ) {
          warnings.push(messages.missingProvenance);
        }

        if (warnings.length) {
          return text(`Wrote ${path}\nOKF warnings: ${warnings.join("; ")}`);
        }
        return text(`Wrote ${path}`);
      }

      case "create_concept": {
        const path = str(args, "path");
        const type = str(args, "type");
        if (!path) return fail("'path' is required");
        if (!type) return fail("'type' is required and must be non-empty (OKF v0.2)");
        if (!/\.md$/i.test(path)) return fail("'path' must end in .md");

        const content = skeletonConcept({
          type,
          title: str(args, "title"),
          description: str(args, "description"),
          tags: strArray(args, "tags"),
          body: str(args, "body"),
          generatedBy: str(args, "actor") || "process:mcp",
        });
        await workspace.writeFile(path, content, {
          by: "agent",
          actor: str(args, "actor") || "process:mcp",
          action: "create",
        });
        return text(`Created ${path}`);
      }

      case "backlinks": {
        const id = str(args, "id");
        if (!id) return fail("'id' is required");
        return json(workspace.requireBundle().backlinksOf(id));
      }

      case "check_conformance": {
        const issues = workspace.conformanceIssues();
        return issues.length === 0 ? text("All documents conform to OKF v0.2.") : json(issues);
      }

      case "audit_changes": {
        const since = str(args, "since");
        if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since.trim())) {
          return fail(`since must be an ISO date: ${since}`);
        }

        const result = await workspace.auditChanges({
          ...(since ? { since: since.trim() } : {}),
          ...(str(args, "actor") ? { actor: str(args, "actor") } : {}),
        });
        if (result.total === 0) return text(messages.auditNoChanges);
        return json(result);
      }

      case "summarize_activity": {
        const since = str(args, "since");
        if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since.trim())) {
          return fail(`since must be an ISO date: ${since}`);
        }
        const until = str(args, "until");
        if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until.trim())) {
          return fail(`until must be an ISO date: ${until}`);
        }
        if (since && until && until.trim() < since.trim()) {
          return fail(`until must not be before since: ${until.trim()} < ${since.trim()}`);
        }

        const result = await workspace.summarizeActivity({
          ...(since ? { since: since.trim() } : {}),
          ...(until ? { until: until.trim() } : {}),
          ...(str(args, "actor") ? { actor: str(args, "actor") } : {}),
          ...(str(args, "by").trim() ? { by: str(args, "by").trim() } : {}),
          save: args.save === true,
        });
        if (result.total === 0) return text("No log entries matched the given range or actor.");
        if (result.saved) return text(`Saved ${result.saved} (${result.total} row(s))`);
        return text(result.markdown);
      }

      case "rebuild_index": {
        const { rows } = await workspace.rebuildIndex();
        return text(`index.md rebuilt with ${rows} concepts`);
      }

      case "rebuild_rag": {
        const { indexed } = await workspace.rebuildRag();
        return text(`Indexed ${indexed} concepts`);
      }

      case "skill_find": {
        const task = str(args, "task");
        if (!task.trim()) return fail("task is required");

        const limitArg = args.limit;
        const result = await workspace
          .requireSkills()
          .find(task, typeof limitArg === "number" ? limitArg : 3);

        if (result.ranked.length === 0) {
          // Say so plainly rather than returning an empty list: an agent given
          // nothing tends to retry, and a retry costs more than an explanation.
          return text(messages.skillNoneMatched(task));
        }
        return json(result);
      }

      case "skill_list": {
        const summaries = await workspace.requireSkills().summaries();
        if (summaries.length === 0) return text(messages.skillSpaceEmpty);
        return json(summaries);
      }

      case "skill_open": {
        const name = str(args, "name");
        if (!name) return fail("name is required");

        const skill = await workspace.requireSkills().open(name);
        const header = [
          `# skill: ${skill.name}`,
          "",
          skill.description,
          skill.resources.length
            ? `\nSupporting files (read with skill_read): ${skill.resources.join(", ")}`
            : "",
          skill.warnings.length ? `\n⚠ ${skill.warnings.join(" / ")}` : "",
          "",
          "---",
          "",
        ].join("\n");
        return text(header + skill.body);
      }

      case "skill_read": {
        const name = str(args, "name");
        const path = str(args, "path");
        if (!name || !path) return fail("name and path are required");

        const resource = await workspace.requireSkills().readResource(name, path);
        return text(resource.content);
      }

      case "set_para": {
        const path = str(args, "path");
        const target = parseParaClass(str(args, "para"));
        if (!path) return fail("'path' is required");
        if (!target) return fail(messages.paraUnknownClass(str(args, "para")));

        const result = await workspace.setPara(path, target, "agent");
        return text(
          result.moved
            ? messages.paraMoved(result.from, result.to, PARA_LABELS[target]) + danglingNote(result.danglingRelations)
            : messages.paraAlready(path, PARA_LABELS[target])
        );
      }

      case "list_para": {
        const only = str(args, "para") ? parseParaClass(str(args, "para")) : null;
        if (str(args, "para") && !only) return fail(messages.paraUnknownClass(str(args, "para")));

        const grouped: Record<string, Array<{ id: string; title: string; type: string }>> = {};
        for (const cls of PARA_ORDER) {
          if (only && cls !== only) continue;
          grouped[cls] = [];
        }

        for (const concept of workspace.requireBundle().allConcepts()) {
          const cls = paraOf(concept.id);
          if (only && cls !== only) continue;
          grouped[cls]?.push({
            id: concept.id,
            title: concept.frontmatter.title ?? concept.id,
            type: concept.frontmatter.type,
          });
        }

        for (const list of Object.values(grouped)) list.sort((a, b) => a.id.localeCompare(b.id));
        return json({ order: PARA_ORDER, groups: grouped });
      }

      case "set_lifecycle": {
        const path = str(args, "path");
        if (!path) return fail("'path' is required");
        const raw = str(args, "lifecycle");
        const lifecycle = parseLifecycle(raw);
        if (!lifecycle) return fail(`lifecycle must be product | dead | none${raw ? `: ${raw}` : ""}`);

        const result = await workspace.setLifecycle(path, lifecycle, str(args, "actor") || "process:mcp");
        return text(
          result.changed
            ? `Set lifecycle of ${path} to ${lifecycle}.`
            : `${path} already has lifecycle ${lifecycle}; nothing changed.`
        );
      }

      case "knowhow_find": {
        const task = str(args, "task");
        if (!task.trim()) return fail("task is required");

        const result = workspace.knowhowFind(task, typeof args.limit === "number" ? args.limit : 3);
        if (result.ranked.length === 0) {
          return text(
            `No know-how matched: ${task}\nNothing recorded applies yet - when you finish, record what you learned with knowhow_add.`
          );
        }
        return json(result);
      }

      case "knowhow_add": {
        const title = str(args, "title").trim();
        if (!title) return fail("'title' is required");
        const body = str(args, "body");
        if (!body.trim()) return fail("'body' is required");
        const actor = str(args, "actor").trim();
        if (!actor) {
          return fail("'actor' is required: say which agent is recording this, e.g. process:claude-code");
        }

        const { path } = await workspace.knowhowAdd({ title, body, tags: strArray(args, "tags"), actor });
        return text(`Recorded know-how ${path}`);
      }

      case "base_list":
        return json(await workspace.baseList());

      case "base_query": {
        const path = str(args, "path");
        if (!path) return fail("'path' is required");
        if (!isBasePath(path)) return fail("'path' must end in .base");
        if (args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1)) {
          return fail("limit must be a positive integer");
        }
        const result = await workspace.baseQuery(
          path,
          str(args, "view") || undefined,
          typeof args.limit === "number" ? args.limit : undefined
        );
        const { markdown, ...rest } = result;
        return json({ path, ...rest, markdown });
      }

      case "base_write": {
        const path = str(args, "path");
        if (!path) return fail("'path' is required");
        if (typeof args.content !== "string") return fail("'content' is required");
        const warnings = await workspace.baseWrite(path, args.content, {
          by: "agent",
          actor: str(args, "actor") || "process:mcp",
        });
        return text(
          warnings.length > 0 ? `Wrote ${path}
Warnings: ${warnings.join("; ")}` : `Wrote ${path}`
        );
      }

      case "canvas_list":
        return json(await workspace.canvasList());

      case "canvas_read": {
        const path = str(args, "path");
        if (!path) return fail("'path' is required");
        if (!isCanvasPath(path)) return fail("'path' must end in .canvas");
        return json(await workspace.canvasRead(path));
      }

      case "canvas_write": {
        const path = str(args, "path");
        if (!path) return fail("'path' is required");
        if (typeof args.content !== "string") return fail("'content' is required");
        await workspace.canvasWrite(path, args.content, {
          by: "agent",
          actor: str(args, "actor") || "process:mcp",
        });
        return text(`Wrote ${path}`);
      }

      case "canvas_from_links": {
        const path = str(args, "path");
        if (!path) return fail("'path' is required");
        if (!isCanvasPath(path)) return fail("'path' must end in .canvas");
        const root = str(args, "root");
        const query = str(args, "query");
        if (!root.trim() && !query.trim()) return fail("'root' or 'query' is required");
        const range = canvasRangeFrom(args);
        if (typeof range === "string") return fail(range);
        const result = await workspace.canvasFromLinks({
          ...(root.trim() ? { root } : {}),
          ...(query.trim() ? { query } : {}),
          ...range,
          includeDead: args.include_dead === true,
          groupByPara: args.group_by_para === true,
          overwrite: args.overwrite === true,
          path,
          by: "agent",
          actor: str(args, "actor") || "process:mcp",
        });
        const noun = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
        return text(
          `Wrote ${result.path}: ${noun(result.concepts, "concept")}, ${noun(result.edges, "edge")}.${
            result.truncated ? ` Left some concepts or edges out (limits: ${MAX_GRAPH_NODES} concepts, ${MAX_CANVAS_EDGES} edges); use a smaller depth or para_depth.` : ""
          }\n\n${result.outline}`
        );
      }

      case "graph_schema":
      {
        // Undeclared types and kinds are advice about the schema, so they live here
        // and check_conformance keeps its original shape.
        const warnings = workspace.schemaWarnings();
        const schema = workspace.graphSchema();
        return json(warnings.length > 0 ? { ...schema, warnings } : schema);
      }

      case "system_map":
        return text(
          await workspace.systemMap({
            refresh: args.refresh === true,
            actor: str(args, "actor") || "process:mcp",
            toolCount: TOOLS.length,
          })
        );

      case "loop_define": {
        const design = await workspace.requireLoops().define({
          goal: str(args, "goal"),
          ...(str(args, "name") ? { name: str(args, "name") } : {}),
          ...(str(args, "skill") ? { skill: str(args, "skill") } : {}),
          ...(strArray(args, "checks").length ? { checks: strArray(args, "checks") } : {}),
        });

        return json({
          name: design.name,
          path: workspace.requireLoops().relPathOf(design.name),
          goal: design.goal,
          skill: design.skill,
          checks: design.checks,
          runs: design.runs,
        });
      }

      case "loop_start": {
        const loops = workspace.requireLoops();
        const goal = str(args, "goal");
        let name = str(args, "name");

        // Define on the spot when the design is new: an agent should not have
        // to make two calls to start work it has already described.
        if (!name && !goal) return fail(messages.loopNeedsGoal);
        if (!name || !(await loops.exists(name).catch(() => false))) {
          if (!goal) return fail(messages.loopUnknown(name));
          const design = await loops.define({
            goal,
            ...(name ? { name } : {}),
          });
          name = design.name;
        }

        const design = await loops.read(name);
        // Only look for a skill when the design does not already name one.
        const found = design.skill
          ? null
          : await workspace.requireSkills().find(design.goal, 3);

        const result = await loops.start({
          name,
          ...(str(args, "actor") ? { actor: str(args, "actor") } : {}),
          ...(found
            ? {
                suggested: found.ranked.map((r) => ({
                  name: r.name,
                  description: r.description,
                  score: r.score,
                })),
              }
            : {}),
        });

        const skill = result.skill ?? result.suggested[0]?.name;
        return json({
          ...result,
          next: skill
            ? `skill_open("${skill}") で手順を読んでから作業してください`
            : "合うスキルはありません。作業後は必ず loop_end を呼んでください",
        });
      }

      case "loop_note": {
        const detail = str(args, "detail");
        if (!detail) return fail("detail is required");

        const loops = workspace.requireLoops();
        if (!loops.runningLoop) return fail(messages.loopNoneRunning);

        await loops.note(str(args, "action") || "note", detail);
        return text("記録しました");
      }

      case "loop_end": {
        const status = str(args, "status");
        const result = await workspace.requireLoops().end({
          ...(str(args, "outcome") ? { outcome: str(args, "outcome") } : {}),
          ...(status === "abandoned" ? { status: "abandoned" as const } : {}),
        });

        const body = [
          `loop ${result.name} 第 ${result.runNumber} 回を閉じました (${result.path})`,
          "",
          ...result.diff,
          ...(result.checks.length
            ? ["", "完了条件（確認してください）:", ...result.checks.map((c) => `- ${c}`)]
            : []),
          result.regressed ? `\n⚠ ${messages.loopRegressed}` : "",
        ].join("\n");

        // Surfaced as an error so a regression cannot be skimmed past.
        return result.regressed ? fail(body) : text(body);
      }

      case "loop_list": {
        const loops = workspace.requireLoops();
        const names = await loops.list();

        const designs = await Promise.all(
          names.map(async (name) => {
            const design = await loops.read(name).catch(() => null);
            if (!design) return null;
            const last = design.history[0];
            return {
              name: design.name,
              goal: design.goal,
              skill: design.skill,
              runs: design.runs,
              ...(last
                ? {
                    lastRun: {
                      started: last.started,
                      status: last.status,
                      ...(last.outcome ? { outcome: last.outcome } : {}),
                    },
                  }
                : {}),
            };
          })
        );

        const running = loops.runningLoop;
        return json({
          running,
          loops: designs.filter(Boolean),
          hint: running
            ? `ループ ${running} が実行中です。終えたら loop_end を呼んでください`
            : "作業前に loop_start を呼んでください（無ければ goal を渡せばその場で作られます）",
        });
      }

      case "loop_read": {
        const name = str(args, "name");
        if (!name) return fail("name is required");
        return json(await workspace.requireLoops().read(name));
      }

      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
