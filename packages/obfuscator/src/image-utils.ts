import { readFileSync, writeFileSync } from 'node:fs';
import type { TransformOutcome, WalkEntry } from './common.js';
import { extension, isImageFile } from './common.js';
import { encodePNG, parsePNG } from './png.js';

/**
 * Deterministic image color/scale transforms for project assets
 * as deterministic, pure PNG helpers plus multi-file batch functions.
 *
 * Faithfulness notes, verified against the disassembled bytecode (pycdas):
 * - `colour_distance` is the original "redmean"-weighted RGB distance; it is defined
 *   but never called by the color-replacement path in the extracted module (dead code).
 *   The replacement path actually uses `color_acquaintance_compare`, a per-channel
 *   absolute-difference tolerance test.
 * - `exchange_image_colors` iterates the color map in insertion order and applies
 *   *every* matching rule to the original pixel value, so the last matching rule wins.
 *   `pickReplacement` reproduces that exactly.
 * - `exchange_image_colors_same_color` overwrites every non-transparent pixel's RGB
 *   with a single target color, leaving alpha untouched.
 * - Scale uses PIL's `Image.BILINEAR`; this port uses center-aligned bilinear
 *   interpolation per channel, which is semantically equivalent (not bit-exact).
 */

/** RGB triple, 0-255 per channel. */
export type RGB = readonly [number, number, number];

/** One parsed color-map rule: source color -> replacement color. */
export interface RecolorRule {
  from: RGB;
  to: RGB;
}

/** Resampling kernel used by scalePixels. */
export type Interpolation = 'nearest' | 'bilinear';

export interface ScaleOptions {
  /** Exact output width (px). Combined with `height` it wins over `scale`. */
  width?: number;
  /** Exact output height (px). */
  height?: number;
  /** Uniform scale factor (e.g. 0.5 halves both dimensions). */
  scale?: number;
  /** Resampling kernel. Defaults to 'bilinear' to match PIL's BILINEAR. */
  interpolation?: Interpolation;
}

/** Parse a `#RGB`/`#RRGGBB` hex color into an RGB triple. Throws on malformed input. */
export function hexToRgb(hex: string): RGB {
  let value = hex.trim();
  if (value.startsWith('#')) value = value.slice(1);
  if (value.length === 3) value = `${value[0]}${value[0]}${value[1]}${value[1]}${value[2]}${value[2]}`;
  if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`Invalid hex color: ${hex}`);
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

/**
 * The original `colour_distance`: redmean-weighted RGB distance.
 * value = sqrt((2 + rmean/256)*R^2 + 4*G^2 + (2 + (255 - rmean)/256)*B^2).
 */
export function colourDistance(rgb1: RGB, rgb2: RGB): number {
  const rmean = (rgb1[0] + rgb2[0]) / 2;
  const r = rgb1[0] - rgb2[0];
  const g = rgb1[1] - rgb2[1];
  const b = rgb1[2] - rgb2[2];
  return Math.sqrt((2 + rmean / 256) * r * r + 4 * g * g + (2 + (255 - rmean) / 256) * b * b);
}

/**
 * The original `color_acquaintance_compare`: true when every channel of `pixel`
 * is within `tolerance` absolute distance of the corresponding `target` channel.
 */
export function colorAcquaintanceCompare(target: RGB, pixel: RGB, tolerance: number): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (Math.abs(target[index]! - pixel[index]!) > tolerance) return false;
  }
  return true;
}

/** Parse a hex color map (target -> replacement) preserving insertion order. */
export function parseColorMap(colorMap: Readonly<Record<string, string>>): RecolorRule[] {
  const rules: RecolorRule[] = [];
  for (const [target, replace] of Object.entries(colorMap)) rules.push({ from: hexToRgb(target), to: hexToRgb(replace) });
  return rules;
}

/**
 * Faithful port of the `exchange_image_colors` inner loop: for a single pixel,
 * apply every rule whose `from` matches within `tolerance`; the last matching rule
 * (in map insertion order) wins. Returns the replacement RGB, or undefined.
 */
export function pickReplacement(r: number, g: number, b: number, map: Readonly<Record<string, string>>, tolerance: number): RGB | undefined {
  const pixel: RGB = [r, g, b];
  let chosen: RGB | undefined;
  for (const [target, replace] of Object.entries(map)) {
    if (colorAcquaintanceCompare(hexToRgb(target), pixel, tolerance)) chosen = hexToRgb(replace);
  }
  return chosen;
}

/** Recolor pixels in place using parsed rules; transparent pixels are skipped. Returns whether anything changed. */
function applyRules(pixels: Uint8Array, rules: readonly RecolorRule[], tolerance: number): boolean {
  let modified = false;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) continue; // faithful: transparent pixels stay untouched
    const pixel: RGB = [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!];
    let chosen: RGB | undefined;
    for (const rule of rules) if (colorAcquaintanceCompare(rule.from, pixel, tolerance)) chosen = rule.to;
    if (!chosen) continue;
    if (chosen[0] !== pixels[index] || chosen[1] !== pixels[index + 1] || chosen[2] !== pixels[index + 2]) modified = true;
    pixels[index] = chosen[0];
    pixels[index + 1] = chosen[1];
    pixels[index + 2] = chosen[2];
  }
  return modified;
}

/**
 * Recolor owned PNGs by a hex color map (`#target -> #replace`). Non-PNG images and
 * undecodable PNGs are reported as unsupported, never corrupted. `seed` is reserved
 * for parity with the other transform modules; the mapping itself is deterministic.
 */
export function recolorImagesByMap(files: WalkEntry[], colorMap: Readonly<Record<string, string>>, tolerance = 20, seed = ''): TransformOutcome {
  void seed;
  const rules = parseColorMap(colorMap);
  const changedPaths: string[] = [];
  let changed = 0;
  let unsupported = 0;
  for (const entry of files) {
    if (!isImageFile(entry.relative)) continue;
    if (extension(entry.relative) !== 'png') { unsupported += 1; continue; }
    const before = readFileSync(entry.absolute);
    const decoded = parsePNG(before);
    if (!decoded) { unsupported += 1; continue; }
    if (!applyRules(decoded.pixels, rules, tolerance)) continue;
    const next = encodePNG(before, decoded);
    if (!next || next.equals(before)) { unsupported += 1; continue; }
    writeFileSync(entry.absolute, next);
    changed += 1;
    changedPaths.push(entry.relative);
  }
  return { changed, changedPaths, unsupported };
}

/** Overwrite every non-transparent pixel's RGB with `color` (same_color). Returns whether anything changed. */
export function recolorSolidPixels(pixels: Uint8Array, color: RGB): boolean {
  let modified = false;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3] === 0) continue;
    if (pixels[index] !== color[0] || pixels[index + 1] !== color[1] || pixels[index + 2] !== color[2]) modified = true;
    pixels[index] = color[0];
    pixels[index + 1] = color[1];
    pixels[index + 2] = color[2];
  }
  return modified;
}

/**
 * Replace every non-transparent pixel of owned PNGs with one color
 * (port of `exchange_image_colors_same_color`).
 */
export function recolorImagesSolid(files: WalkEntry[], color: string, seed = ''): TransformOutcome {
  void seed;
  const rgb = hexToRgb(color);
  const changedPaths: string[] = [];
  let changed = 0;
  let unsupported = 0;
  for (const entry of files) {
    if (!isImageFile(entry.relative)) continue;
    if (extension(entry.relative) !== 'png') { unsupported += 1; continue; }
    const before = readFileSync(entry.absolute);
    const decoded = parsePNG(before);
    if (!decoded) { unsupported += 1; continue; }
    if (!recolorSolidPixels(decoded.pixels, rgb)) continue;
    const next = encodePNG(before, decoded);
    if (!next || next.equals(before)) { unsupported += 1; continue; }
    writeFileSync(entry.absolute, next);
    changed += 1;
    changedPaths.push(entry.relative);
  }
  return { changed, changedPaths, unsupported };
}

/**
 * Center-aligned bilinear (or nearest-neighbor) RGBA resampling. Bilinear is the
 * default and mirrors PIL's `Image.BILINEAR`; it is per-channel and edge-clamped,
 * not bit-identical to Pillow's triangle-kernel affine transform.
 */
export function scalePixels(pixels: Uint8Array, srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number, interpolation: Interpolation = 'bilinear'): Uint8Array {
  if (srcWidth <= 0 || srcHeight <= 0 || dstWidth <= 0 || dstHeight <= 0) throw new Error('Image dimensions must be positive');
  if (pixels.length !== srcWidth * srcHeight * 4) throw new Error(`Pixel buffer length ${pixels.length} does not match ${srcWidth}x${srcHeight} RGBA`);
  const out = new Uint8Array(dstWidth * dstHeight * 4);
  if (srcWidth === dstWidth && srcHeight === dstHeight) { out.set(pixels); return out; }
  const xRatio = srcWidth / dstWidth;
  const yRatio = srcHeight / dstHeight;
  for (let dy = 0; dy < dstHeight; dy += 1) {
    for (let dx = 0; dx < dstWidth; dx += 1) {
      const di = (dy * dstWidth + dx) * 4;
      if (interpolation === 'nearest') {
        const sx = Math.min(srcWidth - 1, Math.floor(dx * xRatio));
        const sy = Math.min(srcHeight - 1, Math.floor(dy * yRatio));
        const si = (sy * srcWidth + sx) * 4;
        out[di] = pixels[si]!;
        out[di + 1] = pixels[si + 1]!;
        out[di + 2] = pixels[si + 2]!;
        out[di + 3] = pixels[si + 3]!;
        continue;
      }
      const cx = Math.min(srcWidth - 1, Math.max(0, (dx + 0.5) * xRatio - 0.5));
      const cy = Math.min(srcHeight - 1, Math.max(0, (dy + 0.5) * yRatio - 0.5));
      const sx0 = Math.floor(cx);
      const sy0 = Math.floor(cy);
      const sx1 = Math.min(srcWidth - 1, sx0 + 1);
      const sy1 = Math.min(srcHeight - 1, sy0 + 1);
      const u = cx - sx0;
      const v = cy - sy0;
      for (let channel = 0; channel < 4; channel += 1) {
        const p00 = pixels[(sy0 * srcWidth + sx0) * 4 + channel]!;
        const p10 = pixels[(sy0 * srcWidth + sx1) * 4 + channel]!;
        const p01 = pixels[(sy1 * srcWidth + sx0) * 4 + channel]!;
        const p11 = pixels[(sy1 * srcWidth + sx1) * 4 + channel]!;
        const top = p00 * (1 - u) + p10 * u;
        const bottom = p01 * (1 - u) + p11 * u;
        out[di + channel] = Math.round(top * (1 - v) + bottom * v);
      }
    }
  }
  return out;
}

/** Resolve the output size from `options`, clamping to at least 1px on each axis. */
export function resolveScaleSize(srcWidth: number, srcHeight: number, options: ScaleOptions): { width: number; height: number } {
  let width: number | undefined = options.width;
  let height: number | undefined = options.height;
  if (width !== undefined && height !== undefined) {
    // exact size wins
  } else if (options.scale !== undefined) {
    if (options.scale <= 0) throw new Error('scale must be positive');
    width = Math.round(srcWidth * options.scale);
    height = Math.round(srcHeight * options.scale);
  } else if (width !== undefined) {
    height = Math.round(srcHeight * (width / srcWidth));
  } else if (height !== undefined) {
    width = Math.round(srcWidth * (height / srcHeight));
  } else {
    width = srcWidth;
    height = srcHeight;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

/**
 * Scale owned PNGs to a target size, ratio, or factor. Non-PNG images and
 * undecodable PNGs are reported as unsupported.
 */
export function scaleImages(files: WalkEntry[], options: ScaleOptions): TransformOutcome {
  const changedPaths: string[] = [];
  let changed = 0;
  let unsupported = 0;
  for (const entry of files) {
    if (!isImageFile(entry.relative)) continue;
    if (extension(entry.relative) !== 'png') { unsupported += 1; continue; }
    const before = readFileSync(entry.absolute);
    const decoded = parsePNG(before);
    if (!decoded) { unsupported += 1; continue; }
    const { width, height } = resolveScaleSize(decoded.width, decoded.height, options);
    if (width === decoded.width && height === decoded.height) continue;
    const pixels = scalePixels(decoded.pixels, decoded.width, decoded.height, width, height, options.interpolation ?? 'bilinear');
    const next = encodePNG(before, { width, height, pixels });
    if (!next || next.equals(before)) { unsupported += 1; continue; }
    writeFileSync(entry.absolute, next);
    changed += 1;
    changedPaths.push(entry.relative);
  }
  return { changed, changedPaths, unsupported };
}

/**
 * Composite RGBA pixels onto a solid background (`remove_transparency`): each pixel
 * becomes `src * (a/255) + bg * (1 - a/255)` and is set fully opaque. The alpha
 * channel is retained as 255 because this package's PNG encoder emits color type 6
 * (RGBA); the resulting image is visually identical to PIL's RGB output.
 */
export function flattenPixels(pixels: Uint8Array, bgColor: RGB): Uint8Array {
  const out = new Uint8Array(pixels.length);
  const [br, bg, bb] = bgColor;
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3]! / 255;
    out[index] = Math.round(pixels[index]! * alpha + br * (1 - alpha));
    out[index + 1] = Math.round(pixels[index + 1]! * alpha + bg * (1 - alpha));
    out[index + 2] = Math.round(pixels[index + 2]! * alpha + bb * (1 - alpha));
    out[index + 3] = 255;
  }
  return out;
}

/**
 * Flatten owned PNGs' alpha onto a background color, removing transparency.
 * Non-PNG images and undecodable PNGs are reported as unsupported.
 */
export function flattenTransparency(files: WalkEntry[], bgColor: RGB = [255, 255, 255]): TransformOutcome {
  const changedPaths: string[] = [];
  let changed = 0;
  let unsupported = 0;
  for (const entry of files) {
    if (!isImageFile(entry.relative)) continue;
    if (extension(entry.relative) !== 'png') { unsupported += 1; continue; }
    const before = readFileSync(entry.absolute);
    const decoded = parsePNG(before);
    if (!decoded) { unsupported += 1; continue; }
    const pixels = flattenPixels(decoded.pixels, bgColor);
    const next = encodePNG(before, { width: decoded.width, height: decoded.height, pixels });
    if (!next || next.equals(before)) continue;
    writeFileSync(entry.absolute, next);
    changed += 1;
    changedPaths.push(entry.relative);
  }
  return { changed, changedPaths, unsupported };
}
