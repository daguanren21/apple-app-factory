import type { Language } from './common.js';
import { deriveHash, deriveToken, replaceWholeWords, seededInt } from './common.js';
import type { CodeOptions } from './config.js';

/**
 * Deterministic in-place code obfuscation primitives. Every exported transform is pure:
 * identical content + language + options + seed produce byte-identical output, and no
 * wall-clock time, randomness or locale state is ever consulted.
 */

interface MaskedParts {
  text: string;
  isPlaceholder: boolean;
  placeholderIndex: number;
  placeholderKind: 'string' | 'comment';
}

interface Masked {
  masked: string;
  /** Original text of every masked string literal, in placeholder order. */
  strings: string[];
  /** Kind of every masked string: 'single', 'double' or 'other'. */
  stringKinds: Array<'single' | 'double' | 'other'>;
  /** Original text of every masked comment, in placeholder order. */
  comments: string[];
  /** Whether each masked comment is a `#!` shebang line. */
  commentKinds: boolean[];
  stringSep: string;
  commentSep: string;
}

/** Control characters are illegal inside real identifiers/expressions, so they cannot collide with code. */
const SEPARATOR_CANDIDATES = ['\u0002', '\u0003', '\u0004', '\u0005', '\u0006', '\u0007', '\u0008', '\u000e', '\u000f'];

/** Pick two placeholder characters that do not occur anywhere in the content. */
function pickSeparators(content: string): { stringSep: string; commentSep: string } {
  let first: string | undefined;
  let second: string | undefined;
  for (const candidate of SEPARATOR_CANDIDATES) {
    if (content.includes(candidate)) continue;
    if (first === undefined) { first = candidate; continue; }
    second = candidate;
    break;
  }
  if (first === undefined || second === undefined) {
    // Source text containing every candidate control char is pathological; fall back to
    // private-use characters, which the same collision logic cannot enter through placeholders.
    return { stringSep: '\ue000', commentSep: '\ue001' };
  }
  return { stringSep: first, commentSep: second };
}

/** Index of the first '\n' or '\r' at or after `start` (content length when absent). */
function lineEnd(content: string, start: number): number {
  const nextLf = content.indexOf('\n', start);
  const nextCr = content.indexOf('\r', start);
  if (nextLf === -1) return nextCr === -1 ? content.length : nextCr;
  if (nextCr === -1) return nextLf;
  return Math.min(nextLf, nextCr);
}

/** Scan a quoted literal body. Raw literals have no escapes; single-line literals end at a newline. */
function scanQuoted(content: string, start: number, quote: string, isRaw: boolean, multiline: boolean): number {
  let index = start;
  while (index < content.length) {
    const char = content[index]!;
    if (!multiline && (char === '\n' || char === '\r')) return index;
    if (!isRaw && char === '\\') { index += 2; continue; }
    if (char === quote) return index + 1;
    index += 1;
  }
  return content.length;
}

/** Scan a triple-quoted literal body: closes only at the full delimiter, never at a lone quote. */
function scanTripleQuoted(content: string, start: number, quote: string, isRaw: boolean): number {
  const delimiter = quote.repeat(3);
  let index = start;
  while (index < content.length) {
    if (!isRaw && content[index] === '\\') { index += 2; continue; }
    if (content.startsWith(delimiter, index)) return index + 3;
    index += 1;
  }
  return content.length;
}

/**
 * Mask every string literal and comment with inert placeholders, left to right, so later
 * replacement passes can never touch literal/comment text. The scanner recognizes, per language:
 * - comments: `//` to end of line, `/* ... *\/` blocks (non-nesting);
 * - strings: 'single' and "double" everywhere; JavaScript backtick templates with `${}`;
 *   Dart raw `r'...'`/`r"..."` and triple-quoted `'''...'''`/`"""..."""` (with `$` interpolation);
 *   Kotlin `"""..."""`; Swift raw `#"..."#` (and deeper `##`/`###` nesting).
 * A backslash skips the next character inside a normal string; a newline before the closing
 * quote ends a single-line string. The `#!` shebang on line 1 of javascript files is treated
 * as a comment so transforms leave it alone.
 */
function maskContent(content: string, language: Language): Masked {
  const { stringSep, commentSep } = pickSeparators(content);
  const parts: MaskedParts[] = [];
  const strings: string[] = [];
  const stringKinds: Array<'single' | 'double' | 'other'> = [];
  const comments: string[] = [];
  const commentKinds: boolean[] = [];
  const javascript = language === 'javascript';

  let index = 0;
  while (index < content.length) {
    // Shebang: line 1 of javascript files.
    if (javascript && index === 0 && content.startsWith('#!')) {
      const end = lineEnd(content, index);
      parts.push({ text: content.slice(index, end), isPlaceholder: true, placeholderIndex: comments.length, placeholderKind: 'comment' });
      comments.push(content.slice(index, end));
      commentKinds.push(true);
      index = end;
      continue;
    }
    // Line comment.
    if (content.startsWith('//', index)) {
      const end = lineEnd(content, index);
      parts.push({ text: content.slice(index, end), isPlaceholder: true, placeholderIndex: comments.length, placeholderKind: 'comment' });
      comments.push(content.slice(index, end));
      commentKinds.push(false);
      index = end;
      continue;
    }
    // Block comment (non-nesting).
    if (content.startsWith('/*', index)) {
      const close = content.indexOf('*/', index + 2);
      const end = close === -1 ? content.length : close + 2;
      parts.push({ text: content.slice(index, end), isPlaceholder: true, placeholderIndex: comments.length, placeholderKind: 'comment' });
      comments.push(content.slice(index, end));
      commentKinds.push(false);
      index = end;
      continue;
    }

    // Dart raw strings.
    if (language === 'dart' && (content.startsWith("r'''", index) || content.startsWith('r"""', index))) {
      const quote = content[index + 1]!;
      const end = scanTripleQuoted(content, index + 4, quote, true);
      const text = content.slice(index, end);
      parts.push({ text, isPlaceholder: true, placeholderIndex: strings.length, placeholderKind: 'string' });
      strings.push(text);
      stringKinds.push('other');
      index = end;
      continue;
    }
    if (language === 'dart' && (content.startsWith("r'", index) || content.startsWith('r"', index))) {
      const quote = content[index + 1]!;
      const end = scanQuoted(content, index + 2, quote, true, false);
      const text = content.slice(index, end);
      parts.push({ text, isPlaceholder: true, placeholderIndex: strings.length, placeholderKind: 'string' });
      strings.push(text);
      stringKinds.push('other');
      index = end;
      continue;
    }
    // Dart and Kotlin triple-quoted strings.
    if ((language === 'dart' || language === 'kotlin') && content.startsWith('"""', index)) {
      const end = scanTripleQuoted(content, index + 3, '"', false);
      const text = content.slice(index, end);
      parts.push({ text, isPlaceholder: true, placeholderIndex: strings.length, placeholderKind: 'string' });
      strings.push(text);
      stringKinds.push('other');
      index = end;
      continue;
    }
    if (language === 'dart' && content.startsWith("'''", index)) {
      const end = scanTripleQuoted(content, index + 3, "'", false);
      const text = content.slice(index, end);
      parts.push({ text, isPlaceholder: true, placeholderIndex: strings.length, placeholderKind: 'string' });
      strings.push(text);
      stringKinds.push('other');
      index = end;
      continue;
    }
    // JavaScript backtick templates (whole template, including ${...}).
    if (javascript && content[index] === '`') {
      const end = scanQuoted(content, index + 1, '`', false, true);
      const text = content.slice(index, end);
      parts.push({ text, isPlaceholder: true, placeholderIndex: strings.length, placeholderKind: 'string' });
      strings.push(text);
      stringKinds.push('other');
      index = end;
      continue;
    }
    // Swift raw strings: #"..."# with deeper # nesting.
    if (language === 'swift' && content[index] === '#') {
      let hashEnd = index;
      while (content[hashEnd] === '#') hashEnd += 1;
      const quote = content[hashEnd];
      if (quote === '"') {
        let cursor = hashEnd + 1;
        let end = -1;
        while (cursor < content.length) {
          const close = content.indexOf('"', cursor);
          if (close === -1) { cursor = content.length; break; }
          let closeEnd = close + 1;
          while (content[closeEnd] === '#') closeEnd += 1;
          if (closeEnd - close - 1 === hashEnd - index) { end = closeEnd; break; }
          cursor = close + 1;
        }
        if (end === -1) end = content.length;
        const text = content.slice(index, end);
        parts.push({ text, isPlaceholder: true, placeholderIndex: strings.length, placeholderKind: 'string' });
        strings.push(text);
        stringKinds.push('other');
        index = end;
        continue;
      }
    }
    // Ordinary quoted strings (every language).
    const char = content[index];
    if (char === "'" || char === '"') {
      const end = scanQuoted(content, index + 1, char, false, false);
      const text = content.slice(index, end);
      parts.push({ text, isPlaceholder: true, placeholderIndex: strings.length, placeholderKind: 'string' });
      strings.push(text);
      stringKinds.push(char === "'" ? 'single' : 'double');
      index = end;
      continue;
    }

    // Plain code run: scan ahead to the next character that can open a comment or string form.
    const end = indexOfAnyFrom(content, index + 1, ["'", '"', '/', '`', '#', 'r']);
    parts.push({ text: content.slice(index, end), isPlaceholder: false, placeholderIndex: -1, placeholderKind: 'string' });
    index = end;
  }

  const masked = parts
    .map((part) => (part.isPlaceholder
      ? part.placeholderKind === 'string'
        ? `${stringSep}${part.placeholderIndex}${stringSep}`
        : `${commentSep}${part.placeholderIndex}${commentSep}`
      : part.text))
    .join('');
  return { masked, strings, stringKinds, comments, commentKinds, stringSep, commentSep };
}

/** First index of any search character at or after `start` (content length when absent). */
function indexOfAnyFrom(content: string, start: number, chars: string[]): number {
  let best = content.length;
  for (const char of chars) {
    const found = content.indexOf(char, start);
    if (found !== -1 && found < best) best = found;
  }
  return best;
}

/** Split masked text into alternating code and placeholder parts. */
function splitMasked(masked: Masked): MaskedParts[] {
  const separatorPattern = new RegExp(
    `${escapeRegExpChar(masked.stringSep)}(\\d+)${escapeRegExpChar(masked.stringSep)}|${escapeRegExpChar(masked.commentSep)}(\\d+)${escapeRegExpChar(masked.commentSep)}`,
    'g',
  );
  const parts: MaskedParts[] = [];
  let last = 0;
  for (const match of masked.masked.matchAll(separatorPattern)) {
    if (match.index! > last) {
      parts.push({ text: masked.masked.slice(last, match.index!), isPlaceholder: false, placeholderIndex: -1, placeholderKind: 'string' });
    }
    const commentGroup = match[2];
    const isComment = commentGroup !== undefined;
    parts.push({
      text: match[0],
      isPlaceholder: true,
      placeholderIndex: Number(isComment ? commentGroup : match[1]),
      placeholderKind: isComment ? 'comment' : 'string',
    });
    last = match.index! + match[0].length;
  }
  if (last < masked.masked.length) {
    parts.push({ text: masked.masked.slice(last), isPlaceholder: false, placeholderIndex: -1, placeholderKind: 'string' });
  }
  return parts;
}

/** Escape a single separator character for interpolation into a RegExp source. */
function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Restore placeholders from `rebuiltMasked`, substituting `rebuildString` output for each string. */
function unmask(rebuiltMasked: string, masked: Masked, rebuildString: (index: number) => string): string {
  const stringPattern = new RegExp(`${escapeRegExpChar(masked.stringSep)}(\\d+)${escapeRegExpChar(masked.stringSep)}`, 'g');
  return rebuiltMasked.replace(stringPattern, (_whole, digits: string) => rebuildString(Number(digits)));
}

/**
 * Remove comments while keeping every newline they contained, so line numbering stays stable.
 * The `#!` shebang on line 1 of javascript files is preserved verbatim.
 */
export function stripComments(content: string, language: Language): string {
  const masked = maskContent(content, language);
  const parts = splitMasked(masked);
  const rebuilt = parts
    .map((part) => {
      if (!part.isPlaceholder) return part.text;
      if (part.placeholderKind === 'string') return `${masked.stringSep}${part.placeholderIndex}${masked.stringSep}`;
      const original = masked.comments[part.placeholderIndex]!;
      if (masked.commentKinds[part.placeholderIndex]) return original;
      return original.replace(/[^\r\n]/g, '');
    })
    .join('');
  return unmask(rebuilt, masked, (index) => masked.strings[index]!);
}

/** Whether a quoted literal is eligible for runtime-decode encryption. */
function isEligible(content: string, quote: string, excludes: readonly string[]): boolean {
  const body = content.slice(1, -1);
  if (body.length === 0) return false;
  if (body.includes('%') || body.includes('$')) return false;
  if (body.startsWith('./') || body.startsWith('../') || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(body)) return false;
  for (const exclude of excludes) {
    if (new RegExp(exclude).test(body)) return false;
  }
  let index = 0;
  while (index < body.length) {
    if (body[index] === '\\') {
      const next = body[index + 1];
      if (next !== '\\' && next !== quote && next !== 'n' && next !== 't' && next !== 'r') return false;
      index += 2;
      continue;
    }
    if (body[index] === quote) return false;
    index += 1;
  }
  return true;
}

/** UTF-16 code units for dart/javascript decode expressions (surrogate pairs for astral code points). */
function utf16Units(content: string): number[] {
  const units: number[] = [];
  for (const char of content) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint > 0xffff) {
      const offset = codePoint - 0x10000;
      units.push(0xd800 + (offset >> 10), 0xdc00 + (offset & 0x3ff));
    } else {
      units.push(codePoint);
    }
  }
  return units;
}

/** Runtime-decode expression replacing the literal, per language. */
function encodeString(content: string, language: Language): string {
  if (language === 'dart') return `String.fromCharCodes(const [${utf16Units(content).join(', ')}])`;
  if (language === 'javascript') return `String.fromCharCode(${utf16Units(content).join(', ')})`;
  if (language === 'java') return `new String(new byte[]{${Array.from(Buffer.from(content, 'utf8')).join(',')}}, java.nio.charset.StandardCharsets.UTF_8)`;
  if (language === 'kotlin') return `String(byteArrayOf(${Array.from(Buffer.from(content, 'utf8')).join(',')}), Charsets.UTF_8)`;
  if (language === 'swift') return `String(bytes: [${Array.from(Buffer.from(content, 'utf8')).map((byte) => `UInt8(${byte})`).join(', ')}], encoding: .utf8)!`;
  return `string([]byte{${Array.from(Buffer.from(content, 'utf8')).join(',')}})`;
}

/**
 * Replace each eligible string literal with a deterministic runtime-decode expression.
 * Eligible literals are non-empty, single/double-quoted (templates, raw and triple-quoted
 * literals are never touched), contain no `%`, no `$`, no path/URL prefix, no disallowed
 * backslash escapes, and match none of the `excludes` regexes.
 */
export function encryptStringLiterals(content: string, language: Language, excludes: readonly string[], seed: string): string {
  void seed; // unit arrays are fully determined by the literal text; the seed is reserved for cross-file salt.
  const masked = maskContent(content, language);
  const encrypted = new Map<number, string>();
  masked.strings.forEach((literal, index) => {
    const kind = masked.stringKinds[index]!;
    if (kind === 'single' || kind === 'double') {
      const quote = kind === 'single' ? "'" : '"';
      if (isEligible(literal, quote, excludes)) encrypted.set(index, encodeString(literal.slice(1, -1), language));
    }
  });
  return unmask(masked.masked, masked, (index) => encrypted.get(index) ?? masked.strings[index]!);
}

/**
 * Rename identifiers in one combined pass: whole-word `mappings` (longest key first) run before
 * `patterns` (regular expressions whose replacements may use $1-style group references). Both
 * operate only on code; string literals and comments are masked and restored untouched.
 */
export function renameIdentifiers(
  content: string,
  language: Language,
  mappings: Readonly<Record<string, string>> = {},
  patterns: ReadonlyArray<{ match: string; replacement: string }> = [],
): string {
  const masked = maskContent(content, language);
  const parts = splitMasked(masked);
  let rebuilt = '';
  for (const part of parts) {
    if (!part.isPlaceholder) {
      // Whole-word keys never span placeholder boundaries (placeholders are control
      // characters outside the identifier class), so per-part replacement is exact.
      let text = replaceWholeWords(part.text, mappings).text;
      for (const pattern of patterns) text = text.replace(new RegExp(pattern.match, 'g'), pattern.replacement);
      rebuilt += text;
    } else if (part.placeholderKind === 'string') {
      rebuilt += `${masked.stringSep}${part.placeholderIndex}${masked.stringSep}`;
    } else {
      rebuilt += `${masked.commentSep}${part.placeholderIndex}${masked.commentSep}`;
    }
  }
  return unmask(rebuilt, masked, (index) => masked.strings[index]!);
}

/**
 * Whole-word replacement of every `keywords` mapping. Applies inside code and inside string
 * literals, but never inside comments.
 */
export function obfuscateKeywords(content: string, language: Language, keywords: Readonly<Record<string, string>>): string {
  const masked = maskContent(content, language);
  const replaced = replaceWholeWords(masked.masked, keywords).text;
  return unmask(replaced, masked, (index) => masked.strings[index]!);
}

const JUNK_FORMATS: Record<Language, (name: string, value: number) => string> = {
  dart: (name, value) => `final ${name} = ${value};`,
  java: (name, value) => `class ${name.charAt(0).toUpperCase()}${name.slice(1)} { static { int j = ${value}; } }`,
  kotlin: (name, value) => `val ${name} = ${value}`,
  // Top-level code is only legal in main.swift; a caseless enum keeps junk compilable in any file.
  swift: (name, value) => `private enum ${name.charAt(0).toUpperCase()}${name.slice(1)} { static let j = ${value} }`,
  javascript: (name, value) => `const ${name} = ${value}; void ${name};`,
  go: (name, value) => `var ${name} = ${value}`,
};

/**
 * Conservative per-language declaration scanners for seed-generated renames. Every pattern
 * anchors at a line start so indented methods (framework callbacks like Flutter's `build`)
 * are never mistaken for declarations; statement call sites such as `return foo(` are
 * filtered out afterwards.
 */
const TYPE_DECLARATION = /(?:^|\n)(?:(?:abstract|base|final|interface|sealed|open|data|public|private|protected|internal|static)\s+)*(?:class|interface|enum|struct|object|union|mixin|extension|protocol|record)\s+([A-Za-z_$][\w$]*)/g;
const TOP_LEVEL_FUNCTION = /(?:^|\n)(?:[A-Za-z_$][\w$<>.,?\[\]]*\s+)+([A-Za-z_$][\w$]*)\s*\(/g;
const STATEMENT_PREFIXES: Readonly<Record<string, true>> = {
  return: true, throw: true, case: true, yield: true, await: true, else: true, do: true, goto: true,
};
/** Names that must never be generated as rename targets (entrypoints, keywords, common false positives). */
const NEVER_RENAME: Readonly<Record<string, true>> = {
  main: true, init: true, on: true, get: true, set: true, build: true,
  new: true, if: true, else: true, for: true, while: true, do: true, switch: true, return: true,
  class: true, struct: true, enum: true, func: true, fun: true, function: true, void: true,
  var: true, val: true, let: true, const: true, final: true, static: true, import: true, export: true,
  package: true, type: true, case: true, default: true, break: true, continue: true, try: true,
  catch: true, throw: true, async: true, await: true, in: true, is: true, as: true, of: true,
  to: true, from: true, this: true, super: true, null: true, true: true, false: true,
};
const DECLARATION_PATTERNS: Record<Language, RegExp[]> = {
  dart: [TYPE_DECLARATION, TOP_LEVEL_FUNCTION],
  java: [TYPE_DECLARATION],
  kotlin: [TYPE_DECLARATION, /(?:^|\n)fun\s+(?:<[^>\n]*>\s*)?([A-Za-z_$][\w$]*)\s*\(/g],
  swift: [TYPE_DECLARATION, /(?:^|\n)func\s+([A-Za-z_$][\w$]*)\s*\(/g],
  javascript: [TYPE_DECLARATION, /(?:^|\n)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g, /(?:^|\n)const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g],
  go: [/(?:^|\n)type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/g, /(?:^|\n)func\s+([A-Za-z_]\w*)\s*\(/g],
};

/** Extract declared type/function names worth renaming; methods and statement sites stay untouched. */
export function extractDeclaredIdentifiers(content: string, language: Language): string[] {
  const names: string[] = [];
  for (const pattern of DECLARATION_PATTERNS[language]) {
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const name = match[1]!;
      if (name in NEVER_RENAME) continue;
      if (pattern === TOP_LEVEL_FUNCTION) {
        const lineStart = content.lastIndexOf('\n', match.index!) + 1;
        const prefix = content.slice(lineStart, match.index!).trim().split(/\s+/).pop();
        if (prefix && prefix in STATEMENT_PREFIXES) continue;
      }
      names.push(name);
    }
  }
  return names;
}

/**
 * Deterministically pick `count` of the declared names (seeded hash ordering) and map each
 * to a seed-derived token. Identical (declared, count, seed) always yields the same mapping;
 * a different seed yields a different selection and different tokens.
 */
export function generateIdentifierMappings(declared: readonly string[], count: number, seed: string): Record<string, string> {
  const unique = [...new Set(declared)].filter(name => !(name in NEVER_RENAME));
  const selected = unique
    .map(name => ({ name, score: deriveHash(seed, 'identifier-select', name) }))
    .sort((a, b) => a.score < b.score ? -1 : a.score > b.score ? 1 : 0)
    .slice(0, Math.max(0, count));
  const mappings: Record<string, string> = {};
  for (const { name } of selected) mappings[name] = deriveToken(seed, 'identifier', name);
  return mappings;
}

/**
 * Append `lines` deterministic junk statements at end of file, ensuring exactly one trailing
 * newline before them. Names and values derive from the seed and the project-relative file
 * path, so two files never share junk names. Non-positive `lines` returns the input unchanged.
 */
export function insertJunkCode(content: string, language: Language, lines: number, seed: string, filePath: string): string {
  if (content.length === 0 || lines <= 0) return content;
  const base = content.replace(/[\t \r\n]+$/, '');
  const statements: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    const name = deriveToken(seed, filePath, 'junk', `${i}`);
    const value = seededInt(seed, `${filePath}:junk:${i}`, 0, 0x7fffffff);
    statements.push(JUNK_FORMATS[language](name, value));
  }
  return `${base}\n${statements.join('\n')}\n`;
}

/**
 * Apply the code transforms in fixed order — stripComments, encryptStringLiterals,
 * renameIdentifiers, obfuscateKeywords, insertJunkCode — each only when enabled in `options`.
 * Deterministic: identical arguments yield byte-identical output. Idempotence is not a
 * contract; the orchestrator restores pristine sources between runs.
 */
export function transformCode(content: string, language: Language, options: CodeOptions, seed: string, filePath: string): string {
  let result = content;
  if (options.removeComments === true) result = stripComments(result, language);
  if (options.encryptStrings) result = encryptStringLiterals(result, language, options.encryptStrings.excludes, seed);
  if (options.renameIdentifiers) {
    result = renameIdentifiers(result, language, options.renameIdentifiers.mappings, options.renameIdentifiers.patterns);
  }
  if (options.keywords && Object.keys(options.keywords).length > 0) result = obfuscateKeywords(result, language, options.keywords);
  if (options.junkCode) result = insertJunkCode(result, language, options.junkCode.lines, seed, filePath);
  return result;
}
