/**
 * Deterministic DFA sensitive-word filter and the algorithms that ship next
 * to it: constant-keyword mixing, project language detection, and ObjC comment
 * removal. GUI, networking and authorization code is intentionally dropped.
 *
 * Everything here is pure and deterministic; keyword names are derived with the
 * seeded helpers from ./common.js, never with Math.random or Date.now.
 */
import { deriveToken } from './common.js';
import { filterList, wordFilterList } from './lexicon-data.js';

// ---------------------------------------------------------------------------
// DFA sensitive-word filter
// ---------------------------------------------------------------------------

/** Word-termination marker stored inside trie nodes. */
const DELIMIT = '\u0000';

/**
 * A trie node maps each character to a child node, and the special `DELIMIT`
 * key to `0` when a sensitive word ends at this node.
 */
interface TrieNode {
  [char: string]: TrieNode | 0;
}

/**
 * Standard DFA (dictionary-tree) sensitive-word filter.
 *
 * Word lists are lower-cased before insertion, matching the original
 * `addSensitiveWords`; messages are scanned as-is. `filter` replaces each hit
 * with `repl` repeated to the length of the matched word and leaves unmatched
 * text unchanged.
 */
export class DFAFilter {
  private readonly keywordChains: TrieNode = {};
  private readonly delimit = DELIMIT;

  constructor(wordList?: Iterable<string>) {
    this.parseSensitiveWords(wordList);
  }

  private parseSensitiveWords(wordList?: Iterable<string>): void {
    const words = wordList ?? wordFilterList;
    for (const word of words) this.addSensitiveWords(String(word).trim());
  }

  /** Insert one sensitive word into the trie (lower-cased and trimmed). */
  addSensitiveWords(keyword: string): void {
    const chars = keyword.toLowerCase().trim();
    if (!chars) return;
    let level: TrieNode = this.keywordChains;
    for (const char of chars) {
      let child = level[char];
      if (typeof child !== 'object') {
        child = {};
        level[char] = child;
      }
      level = child;
    }
    level[this.delimit] = 0;
  }

  /**
   * Replace every sensitive word with `repl` repeated to the matched word's
   * length. Unmatched text is preserved verbatim.
   */
  filter(message: string, repl = '*'): string {
    const out: string[] = [];
    let start = 0;
    while (start < message.length) {
      let level: TrieNode = this.keywordChains;
      let cursor = start;
      let matchEnd = -1;
      while (cursor < message.length) {
        const child = level[message[cursor]!];
        if (typeof child !== 'object') break;
        level = child;
        cursor += 1;
        if (this.delimit in level) matchEnd = cursor;
      }
      if (matchEnd >= 0) {
        out.push(repl.repeat(matchEnd - start));
        start = matchEnd;
      } else {
        out.push(message[start]!);
        start += 1;
      }
    }
    return out.join('');
  }
}

// ---------------------------------------------------------------------------
// Constant-keyword mixing
// ---------------------------------------------------------------------------

const MIN_KEYWORD_LENGTH = 7;

/** ASCII punctuation without `_` (matches `string.punctuation` minus `_`). */
const SPECIAL_PUNCTUATION_CHARS = "!\"#$%&'()*+,-./:;<=>?@[\\]^`{|}~";

function countOccurrences(value: string, char: string): number {
  let count = 0;
  for (const current of value) if (current === char) count += 1;
  return count;
}

/** True when `value` contains any ASCII punctuation other than `_`. */
export function hasSpecialString(value: string): boolean {
  for (const char of value) if (SPECIAL_PUNCTUATION_CHARS.includes(char)) return true;
  return false;
}

const KEYWORD_IGNORE_LIST: readonly string[] = [
  'instance', 'onceToken', 'types', 'WEAKBLOCK', 'ClassMethod', 'manager',
  'diagonal', 'deltas', 'result', 'value', 'className', 'multiplier',
  'decibel', 'platform', 'filePath', 'source', 'identifier', 'components',
  'conversion', 'calendar', 'dateFormatter', 'operationKey', 'componentFlags',
  'nullable', 'nonnull', 'gregorian', 'processPool', 'stringValue', 'encoding',
  'reuseIdentifier', 'locations', 'RotQuatG', 'iterator', 'gQuatRot',
  'HAVE_AES', 'colorSpace', 'contentOffset', 'aapssView',
];

/**
 * Port of `judge_keyword_none`: returns `null` when a candidate keyword must be
 * skipped (too short, system/third-party prefix, common property/method name,
 * or listed in the filter list), otherwise the keyword itself.
 */
export function judgeKeywordNone(keyword: string): string | null {
  if (keyword.length <= MIN_KEYWORD_LENGTH) return null;
  if (keyword.includes('ScreenWidth') || keyword.includes('SCREEN_WIDTH')) return null;
  if (keyword.includes('ScreenHeight') || keyword.includes('SCREEN_HEIGHT')) return null;
  if (keyword.startsWith('once')) return null;
  if (keyword.startsWith('CG')) return null;
  if (keyword.startsWith('NS')) return null;
  if (keyword.startsWith('UI')) return null;
  if (keyword.startsWith('UTF')) return null;
  if (keyword.startsWith('BN_')) return null;
  if (keyword.startsWith('SDWebImage')) return null;
  if (keyword.startsWith('PLATFORM_')) return null;
  if (keyword.startsWith('print')) return null;
  if (keyword.startsWith('UNITY') || keyword.startsWith('Unity')) return null;
  if (keyword.startsWith('APP_CONTROLLER')) return null;
  if (keyword.startsWith('s_')) return null;
  if (keyword.startsWith('count')) return null;
  if (keyword.startsWith('_')) return null;
  if (keyword.startsWith('shared')) return null;
  if (keyword.startsWith('sd_')) return null;
  if (keyword.startsWith('SDImage')) return null;
  if (keyword.startsWith('metamacro_')) return null;
  if (keyword.startsWith('kCGImage')) return null;
  if (keyword.startsWith('YYCGImage')) return null;
  if (keyword.startsWith('MJRefresh')) return null;
  if (keyword.includes('_shared')) return null;
  if (keyword.includes('Base64Encode')) return null;
  if (keyword.includes('md5Key')) return null;
  if (keyword.includes('Instance') || keyword.includes('instance')) return null;
  if (keyword.includes('Assert') || keyword.includes('assert')) return null;
  if (keyword.startsWith('block')) return null;
  if (keyword.startsWith('and')) return null;
  if (keyword.startsWith('NSLog')) return null;
  if (keyword.startsWith('GLES_')) return null;
  if (keyword.startsWith('GTM_')) return null;
  if (keyword.startsWith('CF_')) return null;
  if (keyword.startsWith('SSL3_')) return null;
  if (keyword.startsWith('TLS1_')) return null;
  if (keyword.startsWith('kCVPixel')) return null;
  if (keyword.startsWith('set') || keyword.startsWith('Set')) return null;
  if (keyword.startsWith('get') || keyword.startsWith('Get')) return null;
  if (keyword.startsWith('public_') || keyword.startsWith('PUBLIC_')) return null;
  if (keyword.startsWith('DETAIL_') || keyword.startsWith('Detail_')) return null;
  if (keyword.startsWith('Exchange')) return null;
  if (keyword.startsWith('Compare')) return null;
  if (keyword.startsWith('Increment')) return null;
  if (keyword.startsWith('Decrement')) return null;
  if (keyword.startsWith('IL2CPP_') || keyword.startsWith('il2cpp_')) return null;
  if (keyword.startsWith('detail_')) return null;
  if (keyword.startsWith('Baselib_')) return null;
  if (keyword.startsWith('DEBUG') || keyword.endsWith('DEBUG')) return null;
  if (keyword.startsWith('init')) return null;
  if (keyword.startsWith('Log') || keyword.startsWith('log') || keyword.startsWith('LOG')) return null;
  if (keyword.endsWith('log') || keyword.endsWith('Log') || keyword.endsWith('LOG')) return null;
  if (keyword.includes('Log')) return null;
  if (keyword.includes('_get_')) return null;
  if (keyword.includes('_set_')) return null;
  if (keyword.includes('Class') || keyword.includes('class')) return null;
  if (keyword.endsWith('_SIZE') || keyword.endsWith('_size') || keyword.endsWith('Size')) return null;
  if (keyword.endsWith('DEBUG') || keyword.endsWith('Debug')) return null;
  if (keyword.endsWith('_var')) return null;
  if (keyword.endsWith('Internal')) return null;
  if (keyword.startsWith('Internal')) return null;
  if (keyword.startsWith('RCKit')) return null;
  if (keyword.startsWith('MD5_')) return null;
  if (keyword.startsWith('EVP_')) return null;
  if (keyword.startsWith('NID_')) return null;
  if (keyword.startsWith('VERSION') || keyword.startsWith('Version')) return null;
  if (keyword.startsWith('METHOD_')) return null;
  if (keyword.startsWith('COMPILER_')) return null;
  if (keyword.startsWith('BASELIB') || keyword.startsWith('Baselib')) return null;
  if (KEYWORD_IGNORE_LIST.includes(keyword)) return null;
  if (keyword.includes('_')) {
    const parts = keyword.split('_');
    if (parts[parts.length - 1]!.length === 1) return null;
    if (parts[0]!.length === 1) return null;
  }
  if (keyword.includes('String') && keyword.replaceAll('String', '').length <= 3) return null;
  if (keyword.includes('string') && keyword.replaceAll('string', '').length <= 3) return null;
  if (hasSpecialString(keyword)) return null;
  if (filterList.includes(keyword)) return null;
  return keyword;
}

export interface ConstKeywordHit {
  keyword: string;
  isNeedAddK: boolean;
}

/** Split a source line the way `is_contain_const_keyword` does before keyword selection. */
function splitKeywordLine(line: string, splitOnParen: boolean): string[] {
  let value = line.split('//')[0]!;
  value = value.split('/*')[0]!;
  if (splitOnParen) value = value.split('(')[0]!;
  value = value.split('[')[0]!;
  value = value.split('{')[0]!;
  value = value.split('=')[0]!;
  value = value.replaceAll('*', '').replaceAll('\n', '');
  return value.split(' ').filter(part => part.length > 0);
}

/**
 * Port of `is_contain_const_keyword`'s keyword detection: extract a
 * `const`/`static`/`extern`/`#define` constant identifier from one line, or
 * return `null` when the line carries no mixable keyword.
 */
export function findConstKeyword(line: string): ConstKeywordHit | null {
  let working = line;
  if (working.includes('\t')) working = working.replaceAll('\t', ' ');
  if (working.length === 0) return null;
  if (working.startsWith('//')) return null;
  if (working.startsWith(' *')) return null;
  if (working.includes('dispatch_once_t')) return null;
  if (working.includes('dispatch_queue_t')) return null;
  if (working.includes('dispatch_main_async_safe')) return null;
  if (working.includes('__VA_ARGS__')) return null;
  if (working.startsWith('#define') && working.trimEnd().endsWith('extern')) return null;

  let lineList: string[];
  if (working.includes('static decltype(')) lineList = splitKeywordLine(working, false);
  else if (working.includes('const decltype(')) lineList = splitKeywordLine(working, false);
  else lineList = splitKeywordLine(working, true);

  let isNeedAddK = false;
  let keyword: string | null = null;

  if (lineList.includes('const') && lineList.includes('static')) {
    keyword = lineList[lineList.length - 1]!;
    isNeedAddK = true;
  } else if (lineList.includes('const') && lineList.includes('extern')) {
    keyword = lineList[lineList.length - 1]!;
    isNeedAddK = true;
  } else if (lineList.includes('const')) {
    keyword = lineList[lineList.length - 1]!;
    isNeedAddK = true;
  } else if (lineList.includes('static') && lineList.includes('decltype')) {
    keyword = lineList[lineList.length - 1]!;
    isNeedAddK = false;
  } else if (lineList.includes('static') && !working.includes(' func ') && !working.includes(' var ') && !working.includes('(')) {
    if (working.includes(':')) keyword = (lineList[lineList.length - 2] ?? '').replaceAll(':', '');
    else keyword = lineList[lineList.length - 1]!;
    isNeedAddK = false;
  } else if (lineList.includes('extern') && !lineList.includes('"C"')) {
    keyword = lineList[lineList.length - 1]!;
    isNeedAddK = true;
  } else if (working.startsWith('#define ') && lineList.includes('#define')) {
    keyword = lineList[1] ?? null;
    if (keyword !== null) {
      if (keyword.endsWith('_h') || keyword.endsWith('_pch')) {
        keyword = null;
      } else {
        isNeedAddK = true;
        if (keyword.endsWith('{')) keyword = keyword.slice(0, -1);
        if (keyword.includes('(')) keyword = keyword.split('(')[0]!;
        if (keyword.includes(')')) keyword = keyword.split(')')[0]!;
      }
    }
  }

  if (keyword === null) return null;
  keyword = keyword.trim().replaceAll('\n', '');
  if (keyword.endsWith(';')) keyword = keyword.slice(0, -1);
  if (keyword.startsWith('*')) keyword = keyword.slice(1);
  if (keyword.includes('[')) keyword = keyword.split('[')[0]!;
  if (keyword.includes(']')) keyword = keyword.split(']')[0]!;
  if (working.includes(keyword + '(void)')) keyword = null;

  const judged = keyword === null ? null : judgeKeywordNone(keyword);
  if (judged === null) return null;
  return { keyword: judged, isNeedAddK };
}

const KEYWORD_BOUNDARY_CHARS = [
  '(', ')', ' ', '||', ',', ':', '[', ']', '{', '}', '&', '+', '-', '*', '/',
  '%', '>', '<', '=', '?', '!', '\n', '\t', '^', ';', '~', '@', '.',
];

/**
 * Port of `replace_keyword_in_line`: replace `oldKeyword` with `mixKeyword`
 * when surrounded by identifier boundaries, skipping property/method uses
 * (`self.foo`, header imports, `@property` declarations).
 */
export function replaceKeywordInLine(line: string, oldKeyword: string, mixKeyword: string, isXib = false): string {
  if (line.includes('%"' + oldKeyword + '"')) {
    line = line.replaceAll('%"' + oldKeyword + '"', '%"' + mixKeyword + '"');
  }

  const boundaries = KEYWORD_BOUNDARY_CHARS.slice();
  if (isXib) {
    const lt = boundaries.indexOf('<');
    if (lt >= 0) boundaries.splice(lt, 1);
    const gt = boundaries.indexOf('>');
    if (gt >= 0) boundaries.splice(gt, 1);
    boundaries.push('"');
  }

  if (line.startsWith(oldKeyword)) {
    for (const boundary of boundaries) {
      if (line.startsWith(oldKeyword + boundary)) {
        line = line.replaceAll(oldKeyword + boundary, mixKeyword + boundary);
      }
    }
    return line;
  }

  for (const first of boundaries) {
    for (const second of boundaries) {
      const replaceOld = first + oldKeyword + second;
      const replaceMix = first + mixKeyword + second;
      if (line.trim().startsWith('@property') && first === '*' && second === ';') continue;
      if (line.trim().startsWith('@property') && first === ' ' && second === ';') continue;
      if (first === '+' && second === '.' && line.includes(oldKeyword + '.h')) continue;
      if (first === '.' && line.includes('self.' + oldKeyword)) continue;
      if (first === '.' && line.includes('Self.' + oldKeyword)) continue;
      line = line.replaceAll(replaceOld, replaceMix);
    }
  }
  return line;
}

export interface KeywordMixOptions {
  /** Seed for deterministic replacement-name generation. */
  seed: string;
  /** Optional identifier prefix prepended to every generated name. */
  prefix?: string;
}

export interface KeywordMixResult {
  /** Content with mixable keywords replaced. */
  content: string;
  /** Number of keyword hits (keyword occurrences replaced on distinct lines). */
  count: number;
}

/** Yield file lines exactly like Python's `for line in open(path)`. */
function fileLines(content: string): string[] {
  if (content === '') return [];
  const parts = content.split('\n');
  const lines: string[] = [];
  for (let index = 0; index < parts.length - 1; index += 1) lines.push(parts[index]! + '\n');
  const last = parts[parts.length - 1]!;
  if (last !== '') lines.push(last);
  return lines;
}

function blockCommentStart(lineNew: string): boolean {
  return lineNew.startsWith('/*') && !lineNew.endsWith('*/');
}

/**
 * Discover constant keywords in `content`, then replace each with a seeded
 * `prefix`-prefixed name. The same keyword always maps to the same replacement
 * for a given `seed`, so runs are deterministic and idempotent across files.
 */
export function mixKeywords(content: string, options: KeywordMixOptions): KeywordMixResult {
  const seed = options.seed;
  const prefix = options.prefix ?? '';
  const mapping = new Map<string, string>();
  const order: string[] = [];

  // Pass 1: discover candidates, skipping block-comment regions.
  let inBlockComment = false;
  for (const line of fileLines(content)) {
    const lineNew = line.replaceAll(' ', '').replaceAll('\n', '');
    if (blockCommentStart(lineNew)) inBlockComment = true;
    else if (lineNew.startsWith('*/')) inBlockComment = false;
    if (inBlockComment) continue;
    const hit = findConstKeyword(line);
    if (!hit || mapping.has(hit.keyword)) continue;
    const mix = prefix + (hit.isNeedAddK ? 'k' : '') + deriveToken(seed, 'keyword', hit.keyword);
    mapping.set(hit.keyword, mix);
    order.push(hit.keyword);
  }

  // Pass 2: replace discovered keywords in source order.
  let count = 0;
  inBlockComment = false;
  const output: string[] = [];
  for (const line of fileLines(content)) {
    const lineNew = line.replaceAll(' ', '').replaceAll('\n', '');
    if (blockCommentStart(lineNew)) inBlockComment = true;
    else if (lineNew.startsWith('*/')) inBlockComment = false;
    let current = line;
    if (!inBlockComment) {
      for (const oldKeyword of order) {
        if (!current.includes(oldKeyword)) continue;
        const before = current;
        current = replaceKeywordInLine(current, oldKeyword, mapping.get(oldKeyword)!, false);
        if (current !== before) count += 1;
      }
    }
    output.push(current);
  }

  return { content: output.join(''), count };
}

// ---------------------------------------------------------------------------
// Project development language detection
// ---------------------------------------------------------------------------

export type DetectedLanguage = 'OC' | 'Swift' | 'C++';

export interface LanguageCounts {
  OC: number;
  Swift: number;
  Cpp: number;
}

export interface LanguageDetection {
  language: DetectedLanguage;
  counts: LanguageCounts;
}

/**
 * Count source files by extension and return the dominant language plus
 * per-language counts. Ties resolve in the original priority order
 * OC > Swift > C++; an unrecognized set defaults to OC.
 */
export function detectProjectLanguage(files: readonly string[]): LanguageDetection {
  const counts: LanguageCounts = { OC: 0, Swift: 0, Cpp: 0 };
  for (const file of files) {
    const lower = file.toLowerCase();
    if (lower.endsWith('.m') || lower.endsWith('.mm')) counts.OC += 1;
    else if (lower.endsWith('.swift')) counts.Swift += 1;
    else if (lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.cxx') || lower.endsWith('.c') || lower.endsWith('.hpp')) counts.Cpp += 1;
  }

  let language: DetectedLanguage = 'OC';
  if (counts.Swift > counts.OC && counts.Swift >= counts.Cpp) language = 'Swift';
  else if (counts.Cpp > counts.OC && counts.Cpp > counts.Swift) language = 'C++';
  return { language, counts };
}

// ---------------------------------------------------------------------------
// ObjC comment removal
// ---------------------------------------------------------------------------

export interface NotesState {
  inBlockComment: boolean;
}

function countQuotes(value: string): number {
  return countOccurrences(value, '"');
}

/**
 * Port of `delete_two_line`: strip `//` comments from a line while respecting
 * quote balancing across `//` segments.
 */
export function deleteTwoLineComment(line: string): string {
  if (line.trim().startsWith('//')) {
    line = '';
  } else {
    const newLineList: string[] = [];
    let count = 0;
    const lineList = line.split('//');
    if (lineList.length === 2) {
      line = lineList[0]!;
    } else {
      for (let index = 0; index < lineList.length; index += 1) {
        const linePart = line.split('//')[index]!;
        count += countQuotes(linePart);
        if (count <= 1) newLineList.push(linePart);
        if (count === 2) newLineList.push(linePart);
      }
      line = newLineList.join('//');
    }
    if (line.length > 0) line += '\n';
  }
  return line;
}

/**
 * Port of `delete_line_stars`: remove `/** ... * /` doc blocks and continuous
 * star-comment lines, updating the shared block-comment state.
 */
export function deleteLineStars(line: string, state: NotesState): string {
  if (!line.includes('*/')) state.inBlockComment = true;
  else state.inBlockComment = false;

  const captured: string[] = [];
  for (const match of line.matchAll(/[/\*](.*?)[\*\/]/g)) captured.push(match[1] ?? '');
  const resultList = captured.filter(item => item.length > 0);
  for (const item of resultList) line = line.split('/**' + item + '*/').join('');

  if (line.trim().startsWith('/*')) {
    line = line.slice(0, line.indexOf('/*'));
  } else {
    const newLineList: string[] = [];
    let count = 0;
    const parts = line.split('/*');
    for (let index = 0; index < parts.length; index += 1) {
      const linePart = parts[index]!;
      count += countQuotes(linePart);
      if (count <= 1) newLineList.push(linePart);
      if (count === 2) newLineList.push(linePart);
    }
    line = newLineList.join('//');
  }
  if (line.includes('//')) line = line.split('//')[0]!;
  if (line.length > 0) line += '\n';
  return line + '\n';
}

/**
 * Port of `delete_notes_in_every_line`. Returns `null` for lines that should
 * be dropped (interior of a multi-line block comment).
 */
export function deleteNotesInLine(line: string, state: NotesState): string | null {
  const oldLine = line;
  if (oldLine.startsWith('#pragma once')) return line;
  if (state.inBlockComment && !line.includes('*/')) return null;
  if (state.inBlockComment && line.includes('*/')) {
    state.inBlockComment = false;
    line = line.slice(line.indexOf('*/') + 2);
    if (line.length > 0) line += '\n';
    return line;
  }

  const resultList = line.match(/\/\*{1,2}[\s\S]*?\*\//g) ?? [];
  if (resultList.length > 0) {
    for (const item of resultList) line = line.replaceAll(item, ' ');
  }

  if (line.trim().startsWith('/*') && !line.trim().endsWith('*/') && line.split('//').length >= 2) {
    line = line.split('//')[0]!;
  }
  if (line.trim().startsWith('/*') && line.trim().endsWith('*/') && line.includes('//')) {
    line = line.replaceAll('//', '  ');
  }
  if (line.trim().startsWith('//')) line = '';
  if (line.includes('/*') && !line.includes('/*"')) {
    line = deleteLineStars(line, state);
  }
  if (line.includes('//') && !line.includes('://') && !line.trim().endsWith('*/')) {
    line = deleteTwoLineComment(line);
  }
  if (line.trim().startsWith('#pragma') && !line.trim().startsWith('#pragma pack(')) line = '';
  if (line.trim().startsWith('#warning')) line = '';
  return line;
}

/** Remove ObjC comments from a whole source file's contents. */
export function deleteObjCNotes(content: string): string {
  const state: NotesState = { inBlockComment: false };
  let output = '';
  for (const line of fileLines(content)) {
    const result = deleteNotesInLine(line, state);
    if (result !== null && result.length > 0) output += result;
  }
  return output;
}
