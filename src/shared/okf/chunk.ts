/**
 * Splitting a concept body into retrievable chunks.
 *
 * Whole-document retrieval is the wrong granularity for RAG: a long page
 * returns mostly irrelevant text and crowds the context window. Headings are
 * the author's own structure, so sections make honest chunks — and each one
 * carries its heading path, which gives a model the context a bare excerpt
 * lacks and gives the reader a citable anchor.
 */

import { maskCode } from "./links";

/** Chunks larger than this are split further, at paragraph boundaries. */
export const MAX_CHUNK_CHARS = 1200;
/** Overlap carried into a continuation chunk, so a split cannot orphan a claim. */
export const CHUNK_OVERLAP_CHARS = 120;

export interface Chunk {
  /** Position within the document, 0-based. */
  ord: number;
  /** Heading trail from the top of the document, outermost first. */
  headingPath: string[];
  /** The section's own heading, if it has one. */
  heading: string;
  /** Chunk text, excluding the heading line itself. */
  text: string;
  /** Offset of `text` within the body, for anchoring back to the source. */
  charStart: number;
}

const ATX_HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;

interface Section {
  level: number;
  heading: string;
  headingPath: string[];
  body: string;
  charStart: number;
}

/**
 * Split a body into sections at ATX headings.
 *
 * Headings inside fenced code are ignored: a shell comment starting with `#`
 * would otherwise shred a code block into fragments.
 */
function splitSections(body: string): Section[] {
  const masked = maskCode(body);
  const lines = body.split("\n");
  const maskedLines = masked.split("\n");

  const sections: Section[] = [];
  const trail: Array<{ level: number; heading: string }> = [];

  let current: Section = {
    level: 0,
    heading: "",
    headingPath: [],
    body: "",
    charStart: 0,
  };
  let offset = 0;
  const buffer: string[] = [];

  const flush = () => {
    current.body = buffer.join("\n");
    if (current.body.trim() || current.heading) sections.push({ ...current });
    buffer.length = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = maskedLines[i]?.match(ATX_HEADING_RE);

    if (match) {
      flush();
      const level = match[1]!.length;
      // The real heading text comes from the unmasked line; the masked copy is
      // only used to decide *whether* this line is a heading.
      const heading = (lines[i]!.match(ATX_HEADING_RE)?.[2] ?? match[2] ?? "").trim();

      while (trail.length && trail[trail.length - 1]!.level >= level) trail.pop();
      trail.push({ level, heading });

      current = {
        level,
        heading,
        headingPath: trail.map((entry) => entry.heading),
        body: "",
        charStart: offset + line.length + 1,
      };
    } else {
      buffer.push(line);
    }

    offset += line.length + 1;
  }

  flush();
  return sections;
}

/** Split an over-long section at paragraph boundaries, with a little overlap. */
function splitLongSection(section: Section): Array<{ text: string; charStart: number }> {
  const text = section.body;
  if (text.length <= MAX_CHUNK_CHARS) return [{ text, charStart: section.charStart }];

  const parts: Array<{ text: string; charStart: number }> = [];
  const paragraphs = text.split(/\n{2,}/);

  let buffer = "";
  let bufferStart = 0;
  let cursor = 0;

  for (const paragraph of paragraphs) {
    const at = text.indexOf(paragraph, cursor);
    cursor = at + paragraph.length;

    if (buffer && buffer.length + paragraph.length > MAX_CHUNK_CHARS) {
      parts.push({ text: buffer, charStart: section.charStart + bufferStart });
      const tail = buffer.slice(-CHUNK_OVERLAP_CHARS);
      buffer = `${tail}\n\n${paragraph}`;
      bufferStart = Math.max(0, at - tail.length - 2);
      continue;
    }

    if (!buffer) bufferStart = at;
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }

  if (buffer.trim()) parts.push({ text: buffer, charStart: section.charStart + bufferStart });
  return parts;
}

/**
 * Chunk a concept body.
 *
 * A document with no headings yields a single chunk (or several, if it is long),
 * so short notes are never fragmented for no reason.
 */
export function chunkBody(body: string): Chunk[] {
  const chunks: Chunk[] = [];
  let ord = 0;

  for (const section of splitSections(body)) {
    for (const part of splitLongSection(section)) {
      const text = part.text.trim();
      if (!text) continue;
      chunks.push({
        ord: ord++,
        headingPath: section.headingPath,
        heading: section.heading,
        text,
        charStart: part.charStart,
      });
    }
  }

  return chunks;
}

/** Stable id for a chunk within a document. */
export function chunkId(docId: string, ord: number): string {
  return `${docId}#${ord}`;
}

/** Human-readable location, e.g. `topics/note › Setup › Windows`. */
export function chunkLabel(docId: string, headingPath: readonly string[]): string {
  return [docId, ...headingPath].join(" › ");
}

/**
 * A citation anchor: `topics/note.md#heading-slug`, matching the anchor a
 * Markdown renderer generates, so the reference resolves in other tools too.
 */
export function chunkAnchor(docId: string, heading: string): string {
  if (!heading) return `${docId}.md`;
  return `${docId}.md#${slugifyHeading(heading)}`;
}

export function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[`*_~[\]()]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^\p{Letter}\p{Number}-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
