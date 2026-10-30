import { readFileSync } from 'node:fs';
import type { TransformOutcome, WalkEntry } from './common.js';
import { isReferenceCarrier, replaceWholeWords, writeIfChanged } from './common.js';

/**
 * Deterministic content-level scrubbing across text and code files: whole-word
 * sensitive-word replacement and exact hex-color remapping. Binary resource payloads
 * are never touched here; those belong to the resource transforms.
 */

/**
 * Replace every sensitive word (longest key first) with its configured stand-in.
 * Applies inside text files, code and comments; binary payloads are untouched.
 */
export function filterSensitiveWords(files: WalkEntry[], words: Readonly<Record<string, string>>): TransformOutcome {
  const entries = Object.entries(words).filter(([key, value]) => key.length > 0 && value.length > 0).sort((a, b) => b[0].length - a[0].length);
  if (!entries.length) return { changed: 0, changedPaths: [] };
  const mapping: Record<string, string> = {};
  for (const [key, value] of entries) mapping[key] = value;
  const changedPaths: string[] = [];
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
  return { changed, changedPaths };
}

const HEX_COLOR = /#([0-9A-Fa-f]{6})/g;

/** Normalize map keys to uppercase so '#aabbcc' config keys match '#AABBCC' literals. */
function normalized(map: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  if (!map) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) result[key.toUpperCase()] = value;
  return result;
}

function lookup(maps: ReadonlyArray<Readonly<Record<string, string>> | undefined>, hex: string): string | undefined {
  for (const map of maps) {
    const value = map?.[`#${hex.toUpperCase()}`];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Remap exact six-digit hex color literals in text/code files. Control colors are
 * consulted before font colors; unmatched literals stay unchanged. Each literal is
 * replaced at most once, so mapped values never cascade into further matches.
 */
export function recolorSourceColors(
  files: WalkEntry[],
  controlColors: Readonly<Record<string, string>> | undefined,
  fontColors: Readonly<Record<string, string>> | undefined,
): TransformOutcome {
  if (!controlColors && !fontColors) return { changed: 0, changedPaths: [] };
  const control = normalized(controlColors);
  const font = normalized(fontColors);
  const changedPaths: string[] = [];
  let changed = 0;
  for (const entry of files) {
    if (!isReferenceCarrier(entry.relative)) continue;
    const before = readFileSync(entry.absolute, 'utf8');
    let matched = false;
    const next = before.replace(HEX_COLOR, (literal, hex: string) => {
      const mapped = lookup([control, font], hex);
      if (mapped === undefined) return literal;
      matched = true;
      return `#${mapped.replace(/^#/, '').toLowerCase()}`;
    });
    if (!matched) continue;
    if (writeIfChanged(entry, next)) {
      changed += 1;
      changedPaths.push(entry.relative);
    }
  }
  return { changed, changedPaths };
}
