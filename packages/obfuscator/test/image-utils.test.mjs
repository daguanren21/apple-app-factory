import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  colourDistance, colorAcquaintanceCompare, hexToRgb, pickReplacement,
  recolorImagesByMap, recolorImagesSolid, scaleImages, flattenTransparency,
  scalePixels, flattenPixels,
} from '../dist/image-utils.js';
import { buildPNG, parsePNG } from '../dist/png.js';

function png(width, height, rgba) {
  return buildPNG({ width, height, pixels: Uint8Array.from(rgba) });
}

function tempFile(t, name, buffer) {
  const root = mkdtempSync(join(tmpdir(), 'image-utils-'));
  const absolute = join(root, name);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, buffer);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return absolute;
}

function entry(absolute, relative) {
  return [{ absolute, relative }];
}

// ---- pure functions ----

test('hexToRgb parses #RRGGBB and #RGB', () => {
  assert.deepEqual(hexToRgb('#FF0000'), [255, 0, 0]);
  assert.deepEqual(hexToRgb('#9575CD'), [0x95, 0x75, 0xcd]);
  assert.deepEqual(hexToRgb('#f00'), [255, 0, 0]);
  assert.throws(() => hexToRgb('#12345'));
  assert.throws(() => hexToRgb('red'));
});

test('colourDistance preserves the redmean-weighted formula and is symmetric', () => {
  assert.equal(colourDistance([0, 0, 0], [0, 0, 0]), 0);
  const expected = Math.sqrt((2 + 127.5 / 256) * 255 * 255);
  assert.ok(Math.abs(colourDistance([0, 0, 0], [255, 0, 0]) - expected) < 1e-9);
  assert.equal(colourDistance([0, 0, 0], [255, 0, 0]), colourDistance([255, 0, 0], [0, 0, 0]));
});

test('colorAcquaintanceCompare is per-channel and inclusive of the boundary', () => {
  assert.equal(colorAcquaintanceCompare([0, 0, 0], [20, 0, 0], 20), true);
  assert.equal(colorAcquaintanceCompare([0, 0, 0], [21, 0, 0], 20), false);
  assert.equal(colorAcquaintanceCompare([0, 0, 0], [0, 0, 21], 20), false);
});

test('pickReplacement applies the last matching rule in insertion order', () => {
  assert.deepEqual(pickReplacement(0, 0, 0, { '#000000': '#FF0000', '#010101': '#00FF00' }, 20), [0, 255, 0]);
  assert.equal(pickReplacement(200, 200, 200, { '#000000': '#FF0000' }, 20), undefined);
});

// ---- batch color replacement ----

test('recolorImagesByMap remaps within tolerance, boundary inclusive, transparency untouched', t => {
  const inside = tempFile(t, 'inside.png', png(1, 1, [20, 20, 20, 255]));
  const insideOut = recolorImagesByMap(entry(inside, 'inside.png'), { '#000000': '#FF0000' }, 20);
  assert.equal(insideOut.changed, 1);
  assert.deepEqual([...parsePNG(readFileSync(inside)).pixels], [255, 0, 0, 255]);

  const outside = tempFile(t, 'outside.png', png(1, 1, [21, 21, 21, 255]));
  const outsideOut = recolorImagesByMap(entry(outside, 'outside.png'), { '#000000': '#FF0000' }, 20);
  assert.equal(outsideOut.changed, 0);
  assert.deepEqual([...parsePNG(readFileSync(outside)).pixels], [21, 21, 21, 255]);

  const transparent = tempFile(t, 'transparent.png', png(1, 1, [0, 0, 0, 0]));
  const transparentOut = recolorImagesByMap(entry(transparent, 'transparent.png'), { '#000000': '#FF0000' }, 20);
  assert.equal(transparentOut.changed, 0);
  assert.deepEqual([...parsePNG(readFileSync(transparent)).pixels], [0, 0, 0, 0]);
});

test('recolorImagesSolid replaces every non-transparent pixel with one color', t => {
  const path = tempFile(t, 'solid.png', png(2, 1, [255, 0, 0, 255, 0, 0, 0, 0]));
  const out = recolorImagesSolid(entry(path, 'solid.png'), '#9575CD');
  assert.equal(out.changed, 1);
  assert.deepEqual([...parsePNG(readFileSync(path)).pixels], [0x95, 0x75, 0xcd, 255, 0, 0, 0, 0]);
});

// ---- scaling ----

test('scalePixels resizes with center-aligned bilinear and keeps solid colors exact', () => {
  const src = Uint8Array.from([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]);
  const out = scalePixels(src, 2, 2, 4, 4, 'bilinear');
  assert.equal(out.length, 4 * 4 * 4);
  for (let i = 0; i < out.length; i += 4) assert.deepEqual([...out.subarray(i, i + 4)], [255, 0, 0, 255]);
});

test('scaleImages resizes by explicit size and stays decodable', t => {
  const path = tempFile(t, 'scale.png', png(2, 2, [255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]));
  const out = scaleImages(entry(path, 'scale.png'), { width: 4, height: 4 });
  assert.equal(out.changed, 1);
  const image = parsePNG(readFileSync(path));
  assert.equal(image.width, 4);
  assert.equal(image.height, 4);
  for (let i = 0; i < image.pixels.length; i += 4) assert.deepEqual([...image.pixels.subarray(i, i + 4)], [255, 0, 0, 255]);
});

test('scaleImages supports a uniform scale factor', t => {
  const path = tempFile(t, 'ratio.png', png(4, 2, Array(4 * 2 * 4).fill(0).map((_, i) => (i % 4 === 3 ? 255 : 10))));
  const out = scaleImages(entry(path, 'ratio.png'), { scale: 0.5 });
  assert.equal(out.changed, 1);
  const image = parsePNG(readFileSync(path));
  assert.equal(image.width, 2);
  assert.equal(image.height, 1);
});

// ---- flattening ----

test('flattenTransparency composites alpha onto background and becomes opaque', t => {
  // one semi-transparent green over white, one fully transparent blue
  const path = tempFile(t, 'flat.png', png(2, 1, [0, 255, 0, 128, 0, 0, 255, 0]));
  const out = flattenTransparency(entry(path, 'flat.png'), [255, 255, 255]);
  assert.equal(out.changed, 1);
  const image = parsePNG(readFileSync(path));
  assert.deepEqual([...image.pixels], [127, 255, 127, 255, 255, 255, 255, 255]);
  for (let i = 3; i < image.pixels.length; i += 4) assert.equal(image.pixels[i], 255);
});

test('flattenPixels is pure and opaque images are unchanged', () => {
  const opaque = Uint8Array.from([10, 20, 30, 255]);
  assert.deepEqual([...flattenPixels(opaque, [255, 255, 255])], [10, 20, 30, 255]);
});

// ---- unsupported handling ----

test('image transforms report non-PNG images as unsupported', t => {
  const path = tempFile(t, 'x.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const out = scaleImages(entry(path, 'x.jpg'), { scale: 0.5 });
  assert.equal(out.changed, 0);
  assert.equal(out.unsupported, 1);
});
