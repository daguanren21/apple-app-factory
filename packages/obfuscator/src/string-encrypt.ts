import { readFileSync } from 'node:fs';
import type { TransformOutcome } from './common.js';
import { escapeRegExp, extension, seededInt, walkProject, writeIfChanged } from './common.js';

/**
 * Deterministic plaintext string-encryption pass for ObjC/Swift. Every exported
 * transform is pure: identical content +
 * options produce byte-identical output. The XOR key is an integer 0-255 that is
 * either passed explicitly or derived from a seed via `seededInt`; no wall-clock
 * time or `Math.random` is ever consulted.
 *
 * Original control flow (GUI/network/auth discarded):
 * - ObjC: line-based pass turns eligible `@"..."` literals into `NAME("...")`,
 *   then a whole-file pass rewrites `NAME("...")`/`NNC_CSTRING("...")` into
 *   `NAME(((char []) {<byte^key>, ..., 0}))`. The `.pch` gets a
 *   `decryptConstString(char*, size_t)` helper plus `#define NAME(arr) ...`.
 * - Swift: after the first `import` line a `NAME(ucharArr: [UInt8]) -> String`
 *   helper is injected; eligible `"..."` literals become
 *   `NAME(ucharArr: [<byte^key>, ...])`.
 */

export const DEFAULT_OBJC_NAME = 'NNC_NSSTRING';
export const DEFAULT_SWIFT_NAME = 'OBF_NSSTRING';

export interface StringEncryptOptions {
  /** Deterministic source of the XOR key when `encryptionNum` is omitted. */
  seed?: string;
  /** XOR key (0-255). Explicit keys win over the seed. */
  encryptionNum?: number;
  /** ObjC macro / Swift function name. Defaults to NNC_NSSTRING / OBF_NSSTRING. */
  encryptedName?: string;
}

/** Resolve the XOR key: validate an explicit key, otherwise derive it from the seed. */
export function resolveEncryptionNum(seed: string, encryptionNum?: number): number {
  if (encryptionNum !== undefined) {
    if (!Number.isInteger(encryptionNum) || encryptionNum < 0 || encryptionNum > 255) {
      throw new RangeError(`encryptionNum must be an integer between 0 and 255, got ${encryptionNum}`);
    }
    return encryptionNum;
  }
  if (!seed) throw new Error('string encryption requires encryptionNum or a non-empty seed');
  return seededInt(seed, 'string-encrypt', 0, 255);
}

/** True when any char is in U+4E00..U+9FFF. */
export function isContainChinese(value: string): boolean {
  for (const char of value) {
    if (char >= '\u4e00' && char <= '\u9fff') return true;
  }
  return false;
}

/**
 * First strips the `//` comment (everything after the *last* `//`, matching
 * `split('//')[:-1]`), then returns the index of the last occurrence of
 * `strMark`, or -1.
 */
export function findLast(strValue: string, strMark: string): number {
  let value = strValue;
  if (value.includes('//')) {
    const parts = value.split('//');
    parts.pop();
    value = parts.join('//');
  }
  let lastPosition = -1;
  while (true) {
    const position = value.indexOf(strMark, lastPosition + 1);
    if (position === -1) return lastPosition;
    lastPosition = position;
  }
}

/** ObjC decryptor snippet (port of get_pch_code). */
export function objcStringDecryptor(encryptionNum: number, encryptedName: string = DEFAULT_OBJC_NAME): string {
  const key = `0x${encryptionNum.toString(16)}`;
  return (
    '\nstatic NSString * decryptConstString(char* string, size_t len){\n' +
    '    NSMutableData *data = [NSMutableData dataWithLength:len];\n' +
    '    for (int i = 0; i < len; i++) {\n' +
    `        char c = string[i] ^ ${key};\n` +
    '        [data replaceBytesInRange:NSMakeRange(i, 1) withBytes:&c length:1];\n' +
    '    }\n' +
    '    return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];\n' +
    '}\n' +
    `\n#define ${encryptedName}(arr) decryptConstString(arr, sizeof(arr)-1)\n`
  );
}

/** Swift decryptor snippet (port of get_swift_code). */
export function swiftStringDecryptor(encryptionNum: number, encryptedName: string = DEFAULT_SWIFT_NAME): string {
  return (
    `\npublic func ${encryptedName}(ucharArr: [UInt8]) -> String {\n` +
    `    let decoded = ucharArr.map { $0 ^ ${encryptionNum} }\n` +
    '    return String(decoding: decoded, as: UTF8.self)\n' +
    '}\n'
  );
}

interface Line {
  text: string;
  ending: string;
}

/** Split preserving the exact line endings so re-joined output is byte-stable. */
function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char !== '\n' && char !== '\r') continue;
    if (char === '\r' && content[index + 1] === '\n') {
      lines.push({ text: content.slice(start, index), ending: '\r\n' });
      index += 1;
    } else {
      lines.push({ text: content.slice(start, index), ending: char });
    }
    start = index + 1;
  }
  lines.push({ text: content.slice(start), ending: '' });
  return lines;
}

function joinLines(lines: Line[]): string {
  return lines.map((line) => line.text + line.ending).join('');
}

/** Insert text right before the first line whose text contains `marker`. */
function insertBeforeFirstLineContaining(content: string, marker: string, insert: string): string {
  const lines = splitLines(content);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]!.text.includes(marker)) continue;
    const head = joinLines(lines.slice(0, index));
    const tail = joinLines(lines.slice(index));
    return head + insert + tail;
  }
  return content;
}

/** Insert text right after the first line whose text contains `marker`. */
function insertAfterFirstLineContaining(content: string, marker: string, insert: string): string {
  const lines = splitLines(content);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]!.text.includes(marker)) continue;
    const head = joinLines(lines.slice(0, index + 1));
    const tail = joinLines(lines.slice(index + 1));
    return head + insert + tail;
  }
  return content;
}

/** Inject the ObjC decryptor into `.pch` content (before the first `#endif`). */
export function injectObjcStringDecryptor(content: string, encryptionNum: number, encryptedName: string = DEFAULT_OBJC_NAME): string {
  return insertBeforeFirstLineContaining(content, '#endif', objcStringDecryptor(encryptionNum, encryptedName) + '\n');
}

/** Inject the Swift decryptor into content (after the first `import` line). */
export function injectSwiftStringDecryptor(content: string, encryptionNum: number, encryptedName: string = DEFAULT_SWIFT_NAME): string {
  return insertAfterFirstLineContaining(content, 'import ', swiftStringDecryptor(encryptionNum, encryptedName));
}

/** Decide whether an ObjC line must be skipped by string encryption. */
export function isPassObjCEncryptString(line: string): boolean {
  const noSpaceLine = line.replace(/\s+/g, '');
  if (line.includes('@"\\"')) return true;
  if (isContainChinese(line)) return true;
  if (line.includes('NSLog(@"')) return true;
  if (line.includes('static ')) return true;
  if (line.includes('const ')) return true;
  if (line.includes('"@"')) return true;
  if (line.includes('%p')) return true;
  if (line.includes('"GMT"') || line.includes("'GMT'")) return true;
  if (line.includes('"en_US"') || line.includes("'en_US'")) return true;
  if (line.includes('HH:mm:ss')) return true;
  if (line.includes('yyyy-MM-dd')) return true;
  if (line.includes('"utf-8\\')) return true;
  if (line.includes('@";"')) return true;
  if (line.includes('@"text/"')) return true;
  if (line.includes('@"application/json"')) return true;
  if (line.includes('@"application/xml"')) return true;
  if (line.includes('=%i,')) return true;
  if (line.includes('CFSTR(')) return true;
  if (line.includes('objc_') || line.includes('OBJC_')) return true;
  if (line.startsWith('#define ')) return true;
  if (line.endsWith('"')) return true;
  if (line.includes(' case ')) return true;
  if (noSpaceLine.startsWith('NSAssert(')) return true;
  if (line.includes('Log(@"')) return true;
  if (line.includes('LogDebug(')) return true;
  if (line.includes('@"#@"')) return true;
  return false;
}

/** Decide whether an ObjC line is eligible for string encryption. */
export function isCanMissObjCCodeInLine(line: string): boolean {
  if (line.includes('NSLog')) return false;
  if (line.includes('static')) return false;
  if (line.includes('const')) return false;
  if (line.includes('￥')) return false;
  if (line.includes('$')) return false;
  if (isContainChinese(line)) return false;
  return true;
}

/** Rewrite `@"..."` -> `NAME("...")`, skipping `%` bodies. */
export function replaceObjCQuotes(input: string, encryptedName: string): string {
  return input.replace(/@"([^"]*)"/g, (whole, content: string) =>
    content.includes('%') ? whole : `${encryptedName}("${content}")`,
  );
}

const FORMAT_LITERAL_PATTERN = /@"[^"]*%@[^"]*"|@"[^"]*%s[^"]*"/g;

/**
 * ObjC line transform: protect `%@`/`%s` literals with
 * placeholders, replace remaining `@"..."` literals, restore placeholders, then
 * drop the `@` in front of any pre-existing `NAME(` call.
 */
export function missObjCCodeInLine(line: string, encryptedName: string): string {
  const protectedMatches: string[] = [];
  let result = line.replace(FORMAT_LITERAL_PATTERN, (match) => {
    const placeholder = `【###@@@###】=【${protectedMatches.length}】`;
    protectedMatches.push(match);
    return placeholder;
  });
  result = replaceObjCQuotes(result, encryptedName);
  protectedMatches.forEach((original, index) => {
    result = result.replace(`【###@@@###】=【${index}】`, original);
  });
  result = result.replaceAll(`@${encryptedName}(`, `${encryptedName}(`);
  return result;
}

/** Byte-XOR array body for an ObjC `NAME(((char []) {...}))` literal (port of replace_clear_text_string). */
export function getObjcCharArray(content: string, encryptionNum: number, isMm = false): string {
  const bytes = Buffer.from(content, 'utf8');
  const items = [...bytes].map((byte) => {
    const value = String(byte ^ encryptionNum);
    return isMm ? `static_cast<char>(${value})` : value;
  });
  items.push(isMm ? 'static_cast<char>(0)' : '0');
  return `((char []) {${items.join(', ')}})`;
}

/** Whole-file ObjC pass: `NAME("...")`/`NNC_CSTRING("...")` -> `NAME(((char []) {...}))`. */
export function obfuscateObjCStringLiterals(
  content: string,
  encryptionNum: number,
  encryptedName: string = DEFAULT_OBJC_NAME,
  isMm = false,
): string {
  const pattern = new RegExp(`(${escapeRegExp(encryptedName)}\\(|NNC_CSTRING\\()"(.*?)"(\\))`, 'g');
  return content.replace(pattern, (_whole, prefix: string, body: string, suffix: string) =>
    `${prefix}${getObjcCharArray(body, encryptionNum, isMm)}${suffix}`,
  );
}

/**
 * Full ObjC `.m`/`.mm` transform: line-based eligibility/skip pass followed by the
 * whole-file `obfuscate` pass, producing the final `NAME(((char []) {...}))` form.
 */
export function encryptObjcStringLiterals(
  content: string,
  options: StringEncryptOptions & { isMm?: boolean } = {},
): string {
  const key = resolveEncryptionNum(options.seed ?? '', options.encryptionNum);
  const name = options.encryptedName ?? DEFAULT_OBJC_NAME;
  const isMm = options.isMm ?? false;
  let isAddCodeAtM = false;
  const lines = splitLines(content);
  const out: Line[] = [];
  for (const line of lines) {
    if (line.text.includes('@interface') || line.text.includes('@implementation')) {
      out.push(line);
      isAddCodeAtM = true;
      continue;
    }
    if (isPassObjCEncryptString(line.text)) {
      out.push(line);
      continue;
    }
    if (!isAddCodeAtM) {
      out.push(line);
      continue;
    }
    if (line.text.includes('@"') && isCanMissObjCCodeInLine(line.text)) {
      out.push({ text: missObjCCodeInLine(line.text, name), ending: line.ending });
      continue;
    }
    out.push(line);
  }
  return obfuscateObjCStringLiterals(joinLines(out), key, name, isMm);
}

/** Decide whether a Swift line is eligible for string encryption. */
export function isCanMissSwiftCodeInLine(line: string): boolean {
  const stripped = line.trim();
  if (stripped.startsWith('print(')) return false;
  if (stripped.startsWith('debugPrint(')) return false;
  if (stripped.startsWith('#warning')) return false;
  if (stripped.includes('"""')) return false;
  if (stripped.includes('\\(')) return false;
  if (stripped.includes(' case ')) return false;
  return true;
}

/** Byte-XOR Swift array string `[b0, b1, ...]` (port of getSwiftEncryptCode). */
export function getSwiftEncryptCode(content: string, encryptionNum: number): string {
  const bytes = Buffer.from(content, 'utf8');
  return `[${[...bytes].map((byte) => String(byte ^ encryptionNum)).join(', ')}]`;
}

/** Swift line transform: rewrite eligible `"..."` literals. */
export function missSwiftCodeInLine(line: string, encryptionNum: number, encryptedName: string): string {
  const specialKey = '^$$$^';
  let result = line.replaceAll('""', specialKey);
  const items: string[] = [];
  for (const match of result.matchAll(/"(.+?)"/g)) items.push(match[1]!);
  for (const item of items) {
    if (item.startsWith('\\') || item.startsWith('"') || item.length === 1 || item.startsWith('%')) continue;
    const encrypted = `${encryptedName}(ucharArr: ${getSwiftEncryptCode(item, encryptionNum)})`;
    result = result.split(`"${item}"`).join(encrypted);
  }
  result = result.replaceAll(specialKey, '""');
  return result;
}

/** Full Swift transform: inject the decryptor after `import`, then encrypt literals. */
export function encryptSwiftStringLiterals(
  content: string,
  options: StringEncryptOptions = {},
): string {
  const key = resolveEncryptionNum(options.seed ?? '', options.encryptionNum);
  const name = options.encryptedName ?? DEFAULT_SWIFT_NAME;
  let injected = false;
  let out = '';
  for (const line of splitLines(content)) {
    if (!injected && line.text.includes('import ')) {
      out += line.text + line.ending;
      out += swiftStringDecryptor(key, name);
      injected = true;
      continue;
    }
    if (line.text.includes('"') && isCanMissSwiftCodeInLine(line.text)) {
      out += missSwiftCodeInLine(line.text, key, name) + line.ending;
    } else {
      out += line.text + line.ending;
    }
  }
  return out;
}

/**
 * Batch project transform. `.pch` files receive the ObjC decryptor; `.m`/`.mm`
 * files get their string literals encrypted; `.swift` files get the decryptor
 * injected plus encrypted literals. Returns the uniform TransformOutcome shape.
 */
export function applyStringEncryption(root: string, options: StringEncryptOptions = {}): TransformOutcome {
  const key = resolveEncryptionNum(options.seed ?? '', options.encryptionNum);
  const changedPaths: string[] = [];
  let changed = 0;
  for (const entry of walkProject(root).files) {
    const ext = extension(entry.relative);
    const before = readFileSync(entry.absolute, 'utf8');
    let after: string;
    if (ext === 'pch') {
      after = injectObjcStringDecryptor(before, key, options.encryptedName);
    } else if (ext === 'm' || ext === 'mm') {
      after = encryptObjcStringLiterals(before, { encryptionNum: key, encryptedName: options.encryptedName, isMm: ext === 'mm' });
    } else if (ext === 'swift') {
      after = encryptSwiftStringLiterals(before, { encryptionNum: key, encryptedName: options.encryptedName });
    } else {
      continue;
    }
    if (after !== before) {
      writeIfChanged(entry, after);
      changed += 1;
      changedPaths.push(entry.relative);
    }
  }
  return { changed, changedPaths };
}
