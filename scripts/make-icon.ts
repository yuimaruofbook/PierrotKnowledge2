/**
 * Generate the application icon.
 *
 * Written as a tiny rasteriser plus PNG/ICO encoders rather than shelling out
 * to ImageMagick or `iconutil`: the setup script has to work on a machine with
 * nothing installed but Bun, and a shortcut with a blank icon looks broken.
 *
 *   bun run scripts/make-icon.ts
 *
 * Produces assets/icon.png (512px), assets/icon.ico (Windows, multi-size) and
 * assets/icon.iconset/ (macOS, for iconutil when available).
 */

import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---- pixel buffer ----

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

class Canvas {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    this.data = new Uint8Array(width * height * 4);
  }

  /** Alpha-composite a colour onto one pixel. */
  blend(x: number, y: number, colour: Rgba, coverage = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const alpha = colour.a * coverage;
    if (alpha <= 0) return;

    const at = (y * this.width + x) * 4;
    const dstA = this.data[at + 3]! / 255;
    const outA = alpha + dstA * (1 - alpha);
    if (outA <= 0) return;

    for (let channel = 0; channel < 3; channel++) {
      const src = [colour.r, colour.g, colour.b][channel]!;
      const dst = this.data[at + channel]!;
      this.data[at + channel] = Math.round((src * alpha + dst * dstA * (1 - alpha)) / outA);
    }
    this.data[at + 3] = Math.round(outA * 255);
  }

  /**
   * Fill a shape defined by a signed-distance function.
   *
   * Distances give antialiasing for free: a pixel whose centre sits within half
   * a unit of the edge is blended proportionally, which is what keeps the icon
   * from looking jagged at 16px.
   */
  fill(sdf: (x: number, y: number) => number, colour: Rgba): void {
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const distance = sdf(x + 0.5, y + 0.5);
        const coverage = Math.min(1, Math.max(0, 0.5 - distance));
        if (coverage > 0) this.blend(x, y, colour, coverage);
      }
    }
  }
}

const roundedRect =
  (x0: number, y0: number, x1: number, y1: number, radius: number) => (x: number, y: number) => {
    const cx = Math.max(x0 + radius, Math.min(x, x1 - radius));
    const cy = Math.max(y0 + radius, Math.min(y, y1 - radius));
    const dx = x - cx;
    const dy = y - cy;
    const inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
    const corner = Math.hypot(dx, dy) - radius;
    return inside && dx === 0 && dy === 0 ? -radius : corner;
  };

const circle = (cx: number, cy: number, radius: number) => (x: number, y: number) =>
  Math.hypot(x - cx, y - cy) - radius;

/** Signed distance to a thick line segment. */
const segment =
  (x0: number, y0: number, x1: number, y1: number, width: number) => (x: number, y: number) => {
    const vx = x1 - x0;
    const vy = y1 - y0;
    const lengthSq = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * vx + (y - y0) * vy) / lengthSq));
    return Math.hypot(x - (x0 + t * vx), y - (y0 + t * vy)) - width / 2;
  };

// ---- the icon itself ----

const INK: Rgba = { r: 15, g: 17, b: 21, a: 1 };
const PAPER: Rgba = { r: 246, g: 247, b: 249, a: 1 };
const ACCENT: Rgba = { r: 110, g: 168, b: 254, a: 1 };

/**
 * Three linked nodes: a knowledge graph, which is what the app is for.
 * Drawn at whatever size is asked for so every raster is rendered, not scaled.
 */
function renderIcon(size: number): Canvas {
  const canvas = new Canvas(size, size);
  const u = size / 100;

  canvas.fill(roundedRect(4 * u, 4 * u, 96 * u, 96 * u, 22 * u), INK);
  canvas.fill(roundedRect(4 * u, 4 * u, 96 * u, 96 * u, 22 * u), {
    ...ACCENT,
    a: 0.12,
  });

  const nodes: Array<[number, number]> = [
    [50 * u, 30 * u],
    [30 * u, 66 * u],
    [70 * u, 66 * u],
  ];

  const edge = Math.max(1.5, 4 * u);
  canvas.fill(segment(nodes[0]![0], nodes[0]![1], nodes[1]![0], nodes[1]![1], edge), ACCENT);
  canvas.fill(segment(nodes[0]![0], nodes[0]![1], nodes[2]![0], nodes[2]![1], edge), ACCENT);
  canvas.fill(segment(nodes[1]![0], nodes[1]![1], nodes[2]![0], nodes[2]![1], edge), {
    ...ACCENT,
    a: 0.55,
  });

  const radius = Math.max(2, 11 * u);
  canvas.fill(circle(nodes[0]![0], nodes[0]![1], radius), PAPER);
  canvas.fill(circle(nodes[1]![0], nodes[1]![1], radius * 0.82), ACCENT);
  canvas.fill(circle(nodes[2]![0], nodes[2]![1], radius * 0.82), PAPER);

  return canvas;
}

// ---- PNG ----

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const payload = new Uint8Array(typeBytes.length + body.length);
  payload.set(typeBytes);
  payload.set(body, typeBytes.length);

  const out = new Uint8Array(8 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(payload, 4);
  view.setUint32(out.length - 4, crc32(payload));
  return out;
}

export function encodePng(canvas: Canvas): Uint8Array {
  // Each scanline is prefixed with a filter byte; 0 means "none", which keeps
  // the encoder trivial and costs a little size that deflate mostly recovers.
  const stride = canvas.width * 4;
  const raw = new Uint8Array((stride + 1) * canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(canvas.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, canvas.width);
  view.setUint32(4, canvas.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

// ---- ICO ----

/** Wrap PNG frames in an ICO container. Windows accepts PNG-compressed entries. */
export function encodeIco(frames: Array<{ size: number; png: Uint8Array }>): Uint8Array {
  const headerSize = 6 + frames.length * 16;
  const total = headerSize + frames.reduce((sum, frame) => sum + frame.png.length, 0);

  const ico = new Uint8Array(total);
  const view = new DataView(ico.buffer);

  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, frames.length, true);

  let offset = headerSize;
  frames.forEach((frame, index) => {
    const at = 6 + index * 16;
    // 256px is encoded as 0 — the field is a single byte.
    ico[at] = frame.size >= 256 ? 0 : frame.size;
    ico[at + 1] = frame.size >= 256 ? 0 : frame.size;
    ico[at + 2] = 0; // palette
    ico[at + 3] = 0; // reserved
    view.setUint16(at + 4, 1, true); // colour planes
    view.setUint16(at + 6, 32, true); // bits per pixel
    view.setUint32(at + 8, frame.png.length, true);
    view.setUint32(at + 12, offset, true);

    ico.set(frame.png, offset);
    offset += frame.png.length;
  });

  return ico;
}

// ---- entry point ----

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** Sizes Apple's iconutil expects, as {size, scale} pairs. */
const ICONSET: Array<[number, number]> = [
  [16, 1],
  [16, 2],
  [32, 1],
  [32, 2],
  [128, 1],
  [128, 2],
  [256, 1],
  [256, 2],
  [512, 1],
  [512, 2],
];

export async function generateIcons(outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const written: string[] = [];

  const png512 = encodePng(renderIcon(512));
  await writeFile(join(outDir, "icon.png"), png512);
  written.push("icon.png");

  const ico = encodeIco(
    ICO_SIZES.map((size) => ({ size, png: encodePng(renderIcon(size)) }))
  );
  await writeFile(join(outDir, "icon.ico"), ico);
  written.push("icon.ico");

  const iconset = join(outDir, "icon.iconset");
  await mkdir(iconset, { recursive: true });
  for (const [size, scale] of ICONSET) {
    const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
    await writeFile(join(iconset, name), encodePng(renderIcon(size * scale)));
  }
  written.push("icon.iconset/");

  return written;
}

if (import.meta.main) {
  const outDir = join(import.meta.dir, "..", "assets");
  const written = await generateIcons(outDir);
  console.log(`Wrote ${written.join(", ")} to assets/`);
}
