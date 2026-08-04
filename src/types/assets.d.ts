/**
 * Text imports (`import x from "./y.md" with { type: "text" }`).
 *
 * Lets the scaffold templates stay browsable Markdown files on disk while
 * still being inlined into the binary at build time — one source of truth, no
 * runtime asset-path resolution.
 */
declare module "*.md" {
  const content: string;
  export default content;
}

/**
 * `turndown-plugin-gfm` ships no types. It is a Turndown plugin: a function
 * given the service, so this is the whole surface we use.
 */
declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";
  type Plugin = (service: TurndownService) => void;
  export const gfm: Plugin;
  export const tables: Plugin;
  export const strikethrough: Plugin;
  export const taskListItems: Plugin;
}
