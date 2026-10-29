import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TransformOutcome, WalkEntry } from './common.js';
import {
  basenameWithoutExtension, deriveHash, extension, isImageFile, isReferenceCarrier,
  isResourceFile, replaceWholeWords, writeIfChanged,
} from './common.js';
import type { ResourcesOptions } from './config.js';
import { encodePNG, insertPngChunk, parsePNG } from './png.js';

/**
 * Deterministic resource transforms. Every transform is pure with respect to
 * (files + options + seed): the same owned project produces byte-identical output.
 * Reference-bearing renames rewrite text/code references before moving files, so
 * the project stays buildable while its asset surface no longer reads as the original.
 */

export interface ResourceRenamePlan {
  /** Old project-relative path -> new project-relative path for files that move. */
  renames: Map<string, string>;
  /** Whole-word stem replacements (longest-first) applied to references in text/code files. */
  stems: Record<string, string>;
}

/** Returns `value` when the stem changes, else undefined. */
function stemReplacement(stem: string, key: string, value: string): string | undefined {
  return replaceWholeWords(stem, { [key]: value }).text !== stem ? value : undefined;
}

/**
 * Plan basename-stem renames for resource files: every whole-word `mappings` entry that
 * changes a stem yields a new relative path, unless the target path is already occupied.
 */
export function planResourceRenames(files: WalkEntry[], mappings: Readonly<Record<string, string>>): ResourceRenamePlan {
  const keys = Object.keys(mappings).filter(key => key.length > 0).sort((a, b) => b.length - a.length);
  const renames = new Map<string, string>();
  const stems: Record<string, string> = {};
  const occupied = new Set(files.map(entry => entry.relative));
  for (const entry of files) {
    if (!isResourceFile(entry.relative)) continue;
    const stem = basenameWithoutExtension(entry.relative);
    let next = stem;
    for (const key of keys) {
      const replacement = stemReplacement(next, key, mappings[key]!);
      if (replacement !== undefined) {
        next = replaceWholeWords(next, { [key]: replacement }).text;
        stems[key] = replacement;
      }
    }
    if (next === stem) continue;
    const ext = extension(entry.relative);
    const slash = entry.relative.lastIndexOf('/');
    const directory = slash === -1 ? '' : entry.relative.slice(0, slash + 1);
    const target = `${directory}${next}${ext ? `.${ext}` : ''}`;
    if (occupied.has(target)) continue; // collision: keep the original path
    renames.set(entry.relative, target);
    occupied.add(target);
  }
  return { renames, stems };
}

/** Rewrite whole-word stem references inside text and code files (before any move). */
function rewriteReferences(files: WalkEntry[], stems: Readonly<Record<string, string>>, changedPaths: string[]): number {
  const entries = Object.entries(stems).sort((a, b) => b[0].length - a[0].length);
  if (!entries.length) return 0;
  const mapping: Record<string, string> = {};
  for (const [key, value] of entries) mapping[key] = value;
  let changed = 0;
  for (const entry of files) {
    if (!isReferenceCarrier(entry.relative)) continue;
    const before = readFileSync(entry.absolute, 'utf8');
    const result = replaceWholeWords(before, mapping);
    if (result.count === 0) continue;
    if (writeIfChanged(entry, result.text)) {
      changed += 1;
      changedPaths.push(entry.relative);
    }
  }
  return changed;
}

/** Move planned files into place and rewrite references; returns moved + rewritten counts. */
export function applyResourceRenames(root: string, files: WalkEntry[], plan: ResourceRenamePlan): TransformOutcome {
  const changedPaths: string[] = [];
  const rewritten = rewriteReferences(files, plan.stems, changedPaths);
  let moved = 0;
  for (const [from, to] of plan.renames) {
    const source = join(root, from);
    const target = join(root, to);
    if (!existsSync(source)) continue; // never create paths outside the walked set
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
    moved += 1;
    changedPaths.push(to);
  }
  return { changed: moved + rewritten, changedPaths };
}

/** Deterministic `bytes` of seed-derived payload for hash perturbation. */
function perturbPayload(seed: string, relative: string, bytes: number): Buffer {
  const hex = deriveHash(seed, 'hash-perturb', relative);
  const payload = Buffer.alloc(bytes);
  for (let index = 0; index < bytes; index += 1) {
    const offset = (index * 2) % hex.length;
    payload[index] = parseInt(hex.slice(offset, offset + 2), 16);
  }
  return payload;
}

/** Insert a COM segment directly after the JPEG SOI marker. */
function insertJpegComment(buffer: Buffer, payload: Buffer): Buffer | undefined {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return undefined;
  const segment = Buffer.concat([
    Buffer.from([0xff, 0xfe, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload,
  ]);
  return Buffer.concat([buffer.subarray(0, 2), segment, buffer.subarray(2)]);
}

/** Insert a comment extension (21 FE … 00) before the GIF trailer byte. */
function insertGifComment(buffer: Buffer, payload: Buffer): Buffer | undefined {
  const header = buffer.toString('latin1', 0, 6);
  if (header !== 'GIF89a' && header !== 'GIF87a') return undefined;
  const trailer = buffer.lastIndexOf(0x3b);
  if (trailer === -1) return undefined;
  const blocks: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += 255) {
    const block = payload.subarray(offset, offset + 255);
    blocks.push(Buffer.concat([Buffer.from([block.length]), block]));
  }
  return Buffer.concat([buffer.subarray(0, trailer), Buffer.from([0x21, 0xfe]), ...blocks, Buffer.from([0x00]), buffer.subarray(trailer)]);
}

/**
 * Change every owned PNG/JPEG/GIF payload so its hash no longer matches publicly known
 * assets, while staying decodable: PNG gains an ancillary chunk, JPEG a comment segment,
 * GIF a comment extension. Other image formats are reported as unsupported.
 */
export function perturbImageHashes(files: WalkEntry[], bytes: number, seed: string): TransformOutcome {
  const changedPaths: string[] = [];
  let changed = 0;
  let unsupported = 0;
  for (const entry of files) {
    if (!isImageFile(entry.relative)) continue;
    const before = readFileSync(entry.absolute);
    const payload = perturbPayload(seed, entry.relative, bytes);
    const kind = extension(entry.relative);
    const next = kind === 'png' ? insertPngChunk(before, 'tEXt', Buffer.concat([Buffer.from('Obfuscator\x00', 'latin1'), payload]))
      : kind === 'jpg' || kind === 'jpeg' ? insertJpegComment(before, payload)
        : kind === 'gif' ? insertGifComment(before, payload)
          : undefined;
    if (!next) { unsupported += 1; continue; }
    if (next.equals(before)) continue;
    writeFileSync(entry.absolute, next);
    changed += 1;
    changedPaths.push(entry.relative);
  }
  return { changed, changedPaths, unsupported };
}

interface RecolorRule { from: [number, number, number]; to: [number, number, number]; tolerance: number }

function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Apply one exact/tolerant from->to rule across the image; first matching rule wins per pixel. */
function applyRules(pixels: Uint8Array, rules: readonly RecolorRule[]): boolean {
  let modified = false;
  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index]!, g = pixels[index + 1]!, b = pixels[index + 2]!;
    for (const rule of rules) {
      if (Math.abs(r - rule.from[0]) <= rule.tolerance && Math.abs(g - rule.from[1]) <= rule.tolerance && Math.abs(b - rule.from[2]) <= rule.tolerance) {
        pixels[index] = rule.to[0];
        pixels[index + 1] = rule.to[1];
        pixels[index + 2] = rule.to[2];
        modified = true;
        break;
      }
    }
  }
  return modified;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = l - chroma / 2;
  const [r, g, b] = hue < 60 ? [chroma, x, 0]
    : hue < 120 ? [x, chroma, 0]
      : hue < 180 ? [0, chroma, x]
        : hue < 240 ? [0, x, chroma]
          : hue < 300 ? [x, 0, chroma]
            : [chroma, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Whole-image transforms: hue-shift, invert or channel permutation. */
function applyRecolorAll(pixels: Uint8Array, options: NonNullable<ResourcesOptions['images']>['recolorAll']): boolean {
  if (!options) return false;
  let modified = false;
  for (let index = 0; index < pixels.length; index += 4) {
    const r = pixels[index]!, g = pixels[index + 1]!, b = pixels[index + 2]!, a = pixels[index + 3]!;
    let next = [r, g, b, a] as [number, number, number, number];
    if (options.mode === 'invert') next = [255 - r, 255 - g, 255 - b, a];
    else if (options.mode === 'hue-shift') {
      const [h, s, l] = rgbToHsl(r, g, b);
      const [nr, ng, nb] = hslToRgb(h + options.degrees, s, l);
      next = [nr, ng, nb, a];
    } else {
      const source: Record<string, number> = { R: r, G: g, B: b, A: a };
      next = options.order.length === 4
        ? [source[options.order[0]!]!, source[options.order[1]!]!, source[options.order[2]!]!, source[options.order[3]!]!]
        : [source[options.order[0]!]!, source[options.order[1]!]!, source[options.order[2]!]!, a];
    }
    if (next[0] !== r || next[1] !== g || next[2] !== b || next[3] !== a) modified = true;
    pixels[index] = next[0];
    pixels[index + 1] = next[1];
    pixels[index + 2] = next[2];
    pixels[index + 3] = next[3];
  }
  return modified;
}

/**
 * Recolor owned PNGs: exact/tolerant from->to rules first (first match wins), then an
 * optional whole-image transform. Ancillary chunks survive; unsupported or non-PNG
 * images are reported as unsupported, never corrupted.
 */
export function recolorImages(files: WalkEntry[], images: NonNullable<ResourcesOptions['images']>, _seed: string): TransformOutcome {
  void _seed; // recolor rules are fully specified by the owner; the seed is reserved for cross-file salts
  const rules = images.recolor.map(({ from, to, tolerance }) => ({ from: hexRgb(from), to: hexRgb(to), tolerance: tolerance ?? 0 }));
  const changedPaths: string[] = [];
  let changed = 0;
  let unsupported = 0;
  for (const entry of files) {
    if (!isImageFile(entry.relative)) continue;
    if (extension(entry.relative) !== 'png') { unsupported += 1; continue; }
    const before = readFileSync(entry.absolute);
    const decoded = parsePNG(before);
    if (!decoded) { unsupported += 1; continue; }
    const pixels = decoded.pixels;
    let modified = applyRules(pixels, rules);
    modified = applyRecolorAll(pixels, images.recolorAll) || modified;
    if (!modified) continue;
    const next = encodePNG(before, decoded);
    if (!next || next.equals(before)) { unsupported += 1; continue; }
    writeFileSync(entry.absolute, next);
    changed += 1;
    changedPaths.push(entry.relative);
  }
  return { changed, changedPaths, unsupported };
}
