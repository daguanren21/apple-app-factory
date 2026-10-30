import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { TransformOutcome, WalkEntry } from './common.js';
import {
  classifyLanguage, deriveHash, isImageFile, isTextFile, seededInt, seededRandom,
} from './common.js';

/**
 * Deterministic "project identity rename" pipeline.
 *
 * Every source of randomness is derived from the caller-supplied `seed` via the
 * helpers in common.js. GUI/network/authorization code, the wordnet/nltk lexicon
 * and the xpinyin/pypinyin transliteration libraries are intentionally dropped;
 * Chinese folder names fall back to a deterministic Latin token (see getMissFolderName).
 */

export interface ProjectIdentityOptions {
  /** Replacement .xcodeproj base name. Defaults to a seed-derived token. */
  projectName?: string;
  /** Prefix prepended to every generated folder name. */
  folderPrefix?: string;
  /** Prefix prepended to generated image names. */
  imagePrefix?: string;
  /** Image rename algorithm: 0 = create_miss_image_name, 3 = letters only. */
  imageAlgorithm?: 0 | 1 | 3;
}

export interface PbxGroupRow {
  udid: string;
  name: string;
  missName: string;
  isa: string;
  /** Raw `children = (...)` contents (comment names joined by comma). */
  children: string;
  /** Comma-joined child comment names, used as the map key. */
  childrenNames: string;
  path: string;
  sourceTree: string;
}

/** Same list the original uses to refuse renaming directories. */
export const IGNORE_FOLDERS: readonly string[] = [
  '.xcassets', 'Tests', 'UITests', 'Products', 'Pods', 'Frameworks',
  '.xcworkspace', '.xcodeproj', '.lproj', '.git', '.DS_Store', '.idea', 'Icon\r',
];

export const XIB_KEY_WORDS: readonly string[] = ['initialViewController', 'sceneID'];
export const XIB_PASS_KEY_WORDS: readonly string[] = ['id', 'destination', 'firstItem', 'secondItem'];

/** ISO language codes (keys), plus the literal 'zh'. */
export const LANGUAGE_CODES: readonly string[] = [
  'af', 'sq', 'ar', 'be', 'bg', 'ca', 'zh-CN', 'zh-TW', 'hr', 'cs', 'da', 'nl', 'en',
  'eo', 'et', 'tl', 'fi', 'fr', 'gl', 'de', 'el', 'iw', 'hi', 'hu', 'is', 'id', 'ga',
  'it', 'ja', 'ko', 'la', 'lv', 'lt', 'mk', 'ms', 'mt', 'no', 'fa', 'pl', 'pt', 'ro',
  'ru', 'sr', 'sk', 'sl', 'es', 'sw', 'sv', 'th', 'tr', 'uk', 'vi', 'cy', 'yi', 'zh',
];

/**
 * Small deterministic lexicon stand-in. Only the shape matters (a clean
 * lowercase word), not the exact entry.
 */
const LEXICON: readonly string[] = [
  'amber', 'badger', 'cobalt', 'dune', 'ember', 'falcon', 'granite', 'harbor',
  'indigo', 'juniper', 'kestrel', 'lumen', 'mica', 'nimbus', 'onyx', 'prairie',
  'quartz', 'russet', 'sable', 'tundra', 'umber', 'valley', 'willow', 'xenon',
  'yarrow', 'zephyr', 'acorn', 'birch', 'cedar', 'delta', 'eagle', 'frost',
  'grove', 'hollow', 'iron', 'jade', 'kelp', 'larch', 'meadow', 'north',
  'oak', 'pine', 'quill', 'ridge', 'stone', 'thicket', 'violet', 'wheat',
];

function isContainChinese(value: string): boolean {
  return /[一-鿿]/.test(value);
}

function isNumberString(value: string): boolean {
  return /[0-9]+/.test(value);
}

function isDigitString(value: string): boolean {
  return value.length > 0 && /^[0-9]+$/.test(value);
}

/** Python str.title() for a single alphanumeric fragment. */
function titleCase(value: string): string {
  return value.length ? value[0]!.toUpperCase() + value.slice(1).toLowerCase() : value;
}

/** Python str.capitalize() for a single alphanumeric fragment. */
function capitalize(value: string): string {
  return value.length ? value[0]!.toUpperCase() + value.slice(1) : value;
}

function isLowerAscii(value: string): boolean {
  return /^[a-z]$/.test(value);
}

function randomChars(seed: string, salt: string, alphabet: string, length: number): string {
  const random = seededRandom(deriveHash(seed, salt));
  let out = '';
  for (let index = 0; index < length; index += 1) out += alphabet[Math.floor(random() * alphabet.length)]!;
  return out;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function randomStringWithNumber(seed: string, salt: string, length: number): string {
  return randomChars(seed, salt, ALNUM, length);
}

function randomStringNoNumber(seed: string, salt: string, length: number): string {
  return randomChars(seed, salt, LETTERS, length);
}

function randomWord(seed: string, salt: string): string {
  return LEXICON[seededInt(seed, salt, 0, LEXICON.length - 1)]!;
}

function randomWordTitle(seed: string, salt: string): string {
  return capitalize(randomWord(seed, salt));
}

/**
 * Folder rename: strip a "(...)" suffix, replace dots with
 * underscores, remove digits, split camelCase on uppercase boundaries and keep
 * only the last meaningful fragment, then prepend a seed-derived title word.
 */
export function getMissFolderName(folderName: string, seed: string): string {
  if (folderName.includes('(')) folderName = folderName.slice(0, folderName.indexOf('('));
  if (folderName.includes('.')) folderName = folderName.replace(/\./g, '_');
  if (isContainChinese(folderName)) {
    const stripped = folderName.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    return capitalize(stripped) || randomWordTitle(seed, 'folder:chinese');
  }
  for (let num = 0; num < 10; num += 1) folderName = folderName.split(String(num)).join('');
  let folderNameList = folderName.replace(/[A-Z]/g, match => `_${match}`).split('_').filter(item => item.length > 1);
  if (folderNameList.length > 2) folderNameList = folderNameList.slice(-1);
  folderNameList = [randomWordTitle(seed, `folder:${folderName}`), ...folderNameList];
  return folderNameList.join('');
}

/**
 * Parse the PBXGroup section of a project.pbxproj file into
 * `childrenNames -> row`.
 */
export function parsePbxGroups(content: string, seed: string, folderPrefix: string): Map<string, PbxGroupRow> {
  const map = new Map<string, PbxGroupRow>();
  const lines = content.split('\n');
  let inGroup = false;
  let row = '';
  for (const line of lines) {
    if (line.includes('/* Begin PBXGroup section */')) { inGroup = true; continue; }
    if (line.includes('/* End PBXGroup section */')) { inGroup = false; continue; }
    if (inGroup && !line.includes('/* Begin PBXGroup section */')) {
      row += line;
      if (line.includes('};')) {
        const parsed = parsePbxGroupOneRow(row, seed, folderPrefix);
        if (parsed) map.set(parsed.childrenNames, parsed);
        row = '';
      }
    }
  }
  return map;
}

function parsePbxGroupOneRow(row: string, seed: string, folderPrefix: string): PbxGroupRow | undefined {
  let udid = '';
  let name = '';
  let isa = '';
  let children = '';
  let childrenNames = '';
  let path = '';
  let sourceTree = '';

  const flat = row.replace(/\n/g, '').split(/\s+/).join('');
  const udidName = flat.slice(0, flat.indexOf('='));
  if (udidName.includes('/*') && udidName.includes('*/')) {
    udid = udidName.slice(0, udidName.indexOf('/*'));
    name = udidName.slice(udidName.indexOf('/*') + 2, udidName.indexOf('*/'));
  } else {
    udid = udidName;
  }
  if (name.length === 0) return undefined;

  const body = flat.slice(flat.indexOf('={') + 2, flat.indexOf('};'));
  for (const value of body.split(';')) {
    if (value.includes('isa=')) { isa = value.split('isa=').pop()!; continue; }
    if (value.includes('children=')) {
      children = value.split('children=').pop()!.slice(1, -2);
      const names: string[] = [];
      for (const item of children.split(',')) {
        if (item.includes('/*') && item.includes('*/')) {
          names.push(item.slice(item.indexOf('/*') + 2, item.indexOf('*/')));
        }
      }
      childrenNames = names.join(',');
      continue;
    }
    if (value.includes('path=')) { path = value.split('path=').pop()!; continue; }
    if (value.includes('sourceTree=')) { sourceTree = value.split('sourceTree=').pop()!; continue; }
  }

  const missName = folderPrefix + getMissFolderName(name, seed);
  return { udid, name, missName, isa, children, childrenNames, path, sourceTree };
}

/**
 * Image-name generation, with `random.sample`/`random.choice` and
 * `random_word_from_lexicon` replaced by a single seed-derived stream.
 */
export function createMissImageName(imageName: string, seed: string): string {
  const random = seededRandom(deriveHash(seed, 'image', imageName));
  const word = () => LEXICON[Math.floor(random() * LEXICON.length)]!;
  const choice = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const sampleTwo = (items: string[]): string[] => {
    const copy = items.slice();
    for (let index = 0; index < 2 && index < copy.length - 1; index += 1) {
      const target = index + Math.floor(random() * (copy.length - index));
      [copy[index], copy[target]] = [copy[target]!, copy[index]!];
    }
    return copy.slice(0, 2);
  };

  let result = imageName.replace(/-/g, '_');
  let isLine = false;
  if (isContainChinese(result)) {
    const chinese = result.match(/[一-鿿]+/g) ?? [];
    for (const item of chinese) result = result.split(item).join(word());
  }
  if (/\d/.test(result)) result = result.replace(/\d/g, '');
  if (result.includes('_')) {
    isLine = true;
    if (result.endsWith('_')) result = result.slice(0, -1);
    const parts = result.split('_');
    result = '';
    for (const item of parts) if (!isNumberString(item)) result += titleCase(item);
  }
  if (result.includes(' ')) {
    if (result.endsWith(' ')) result = result.slice(0, -1);
    const parts = result.split(' ');
    result = '';
    for (const item of parts) if (!isNumberString(item)) result += item;
  }
  let splitSource = result.replace(/[A-Z]/g, match => `==${match}`);
  if (splitSource.startsWith('==')) splitSource = splitSource.slice(2);
  let nameList = splitSource.split('==');
  if (nameList.length >= 2) {
    nameList = sampleTwo(nameList);
  } else {
    const imageCode = choice(['icon', 'img', 'image', 'pic', 'bg', 'name', 'back', 'add', 'left', 'right', word()]);
    nameList.splice(-1, 0, imageCode);
  }
  const last = nameList.length - 1;
  if (!isLine) {
    nameList[last] = titleCase(nameList[last]!);
    nameList[last - 1] = titleCase(nameList[last - 1]!);
  } else {
    nameList[last] = nameList[last]!.toLowerCase();
    nameList[last - 1] = nameList[last - 1]!.toLowerCase();
  }
  nameList.splice(0, 0, word());
  return isLine ? nameList.join('_') : nameList.join('');
}

/**
 * New image-name generation. Preserves count/language-suffixed variants
 * (counted variants are left unchanged).
 */
export function getNewImageName(imageName: string, imageNamePrefix: string, seed: string, algorithm = 0): string {
  if (!imageName) return imageName;
  const imageNameList = imageName.split('_');
  if (imageNameList.length >= 2) {
    const last = imageNameList.at(-1)!;
    if (isDigitString(last)) return imageName;
    if (!isDigitString(last) && LANGUAGE_CODES.includes(last)) return imageName;
  }
  let missImageName: string;
  if (imageNamePrefix && imageNamePrefix.length > 0 && imageNamePrefix.endsWith('#')) {
    return `${imageNamePrefix.split('#')[0]}${imageName}`;
  }
  if (algorithm === 0) missImageName = createMissImageName(imageName, seed);
  else if (algorithm === 3) missImageName = randomStringNoNumber(seed, `img-len:${imageName}`, imageName.length);
  else missImageName = createMissImageName(imageName, seed);

  let prefix = imageNamePrefix ?? '';
  if (prefix.length > 0 && imageName.includes('_')) {
    if (!prefix.endsWith('_')) return `${prefix}_${missImageName}`;
    return `${prefix}${missImageName}`;
  }
  let firstCharacter = missImageName.slice(0, 1);
  const surplus = missImageName.slice(1);
  firstCharacter = isLowerAscii(imageName.slice(0, 1)) ? firstCharacter.toLowerCase() : capitalize(firstCharacter);
  return `${prefix}${firstCharacter}${surplus}`;
}

/**
 * Xib id/destination rename: three hyphen-separated segments,
 * no Chinese, no colon, replaced with same-length alphanumeric segments.
 */
export function getIdDestinationMissName(name: string, seed: string): string | null {
  const parts = name.split('-');
  if (parts.length === 2 && name.startsWith('-')) return null;
  if (!name.includes('-')) return null;
  if (parts.length !== 3) return null;
  if (isContainChinese(name)) return null;
  if (name.includes(':')) return null;
  return parts.map((item, index) => randomStringWithNumber(seed, `xib:${name}:${index}`, item.length)).join('-');
}

export interface XibKeywordMap {
  map: Map<string, string>;
  keywords: string[];
}

/**
 * Xib/storyboard id+destination map. Returns the attribute map
 * and the (possibly extended) keyword list used to discover custom attributes.
 */
export function getXibStoryboardMap(line: string, keywords: readonly string[], passKeywords: readonly string[]): XibKeywordMap | null {
  let newLine = line.trim();
  if (line.includes('com.apple.InterfaceBuilder')) return null;
  if (newLine.startsWith('<') && !newLine.startsWith('</') && newLine.endsWith('>')) {
    newLine = newLine.slice(newLine.indexOf(' ') + 1, newLine.indexOf('>'));
  } else {
    return null;
  }
  const nextKeywords = keywords.slice();
  const map = new Map<string, string>();
  for (let item of newLine.split(' ')) {
    if (item.endsWith('/')) item = item.slice(0, -1);
    item = item.replace(/"/g, '');
    const pair = item.split('=');
    if (pair.length === 2 && pair[1]!.includes('-') && pair[1]!.split('-').length === 3 && !nextKeywords.includes(pair[0]!)) {
      if (passKeywords.length !== 0 && !passKeywords.includes(pair[0]!)) nextKeywords.push(pair[0]!);
    }
    if (item.includes('=') && nextKeywords.includes(item.split('=')[0]!)) {
      const kv = item.split('=');
      map.set(kv[0]!, kv[1]!);
    }
  }
  return { map, keywords: nextKeywords };
}

export interface XibLineResult {
  line: string;
  keywords: string[];
  missMap: Map<string, string>;
}

/**
 * Xib/storyboard line transform. Pure per-line transform; the caller
 * threads the `missMap` (xs_miss_map_list) and keyword list between lines.
 */
export function replaceXibStoryboardLine(
  line: string,
  keywords: readonly string[],
  passKeywords: readonly string[],
  missMap: Map<string, string>,
  seed: string,
): XibLineResult {
  const parsed = getXibStoryboardMap(line, keywords, passKeywords);
  if (!parsed) return { line, keywords: keywords.slice(), missMap };
  let missLine = line;
  for (const item of parsed.keywords) {
    const value = parsed.map.get(item);
    if (value === undefined) continue;
    let missValue = missMap.get(value);
    if (missValue === undefined) {
      const generated = getIdDestinationMissName(value, seed);
      if (generated !== null) missMap.set(value, generated);
      missValue = missMap.get(value);
    }
    if (missValue !== undefined) missLine = missLine.split(value).join(missValue);
  }
  return { line: missLine, keywords: parsed.keywords, missMap };
}

/** Extract keyword matches from a .strings line. */
export function getStringKeywords(line: string): string[] | null {
  const matches = [...line.matchAll(/"([^"]*-[^"]*)"/g)].map(match => match[1]!);
  if (matches.length === 0) return null;
  return matches.map(match => match.split('.')[0]!);
}

/** Replace keywords in a .strings line. */
export function replaceStringKeywords(line: string, missMap: ReadonlyMap<string, string>): string {
  const keywords = getStringKeywords(line);
  if (!keywords || keywords.length === 0) return line;
  let out = line;
  for (const keyword of keywords) {
    const value = missMap.get(keyword);
    if (value !== undefined) out = out.split(keyword).join(value);
  }
  return out;
}

/** True when `propertyName` is not preceded by an identifier character. */
function judgeFrontSpecialCharacter(line: string, propertyName: string): boolean {
  const allowed = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
  if (line.includes(propertyName)) {
    const index = line.indexOf(propertyName);
    const previous = line.slice(index - 1, index);
    if (previous.length > 0 && allowed.includes(previous)) return false;
  }
  return true;
}

/**
 * project.pbxproj project-name rewrite, as a per-line pure transform.
 */
export function replaceProjectNameInLine(
  line: string,
  original: string,
  replacement: string,
  oldBridge: string,
  newBridge: string,
): string {
  const skipHeader = line.includes('.h') && !line.includes('Pods-');
  const skipSource = line.includes('.m') && !line.includes('Tests.m') && !line.includes('Pods-');
  const skipPod = line.includes("pod '");
  if (!skipHeader && !skipSource && !skipPod && judgeFrontSpecialCharacter(line, original)) {
    line = line.split(original).join(replacement);
  }
  if (line.includes(oldBridge)) line = line.split(oldBridge).join(newBridge);
  if (line.includes('SWIFT_OBJC_BRIDGING_HEADER') && line.includes(`${original}/`)) {
    line = line.split(`${original}/`).join(`${replacement}/`);
  }
  return line;
}

/**
 * Image-reference line rewrite. `imageType` is sourceTypeMap[imageName]
 * (e.g. ".png", "@2x.png", or a comma list); pass undefined for plain references.
 */
export function replaceImageNameLine(
  line: string,
  imageName: string,
  newImageName: string,
  filePath: string,
  imageType?: string,
): string {
  let prevWord = '';
  if (filePath.endsWith('.xcodeproj/project.pbxproj')) prevWord = '/* ';

  if (filePath.endsWith('.swift')) {
    if (line.includes(`"${imageName}"`)) return line.split(`"${imageName}"`).join(`"${newImageName}"`);
    if (line.includes(`"${imageName}.`)) return line.split(`"${imageName}.`).join(`"${newImageName}.`);
    return line;
  }
  if (filePath.endsWith('.cpp')) {
    if (line.includes(`"${imageName}"`)) return line.split(imageName).join(newImageName);
    if (line.includes(`/${imageName}.`)) return line.split(imageName).join(newImageName);
    if (line.includes(`"${imageName}.`)) return line.split(imageName).join(newImageName);
    return line;
  }

  if (imageType !== undefined && !line.includes('imageNamed:@"') && !line.includes('imageFromBundle:@"')) {
    if (imageType.includes(',')) {
      for (const type of imageType.split(',')) {
        if (line.includes(`${imageName}${type}`)) {
          line = line.split(`${prevWord}${imageName}${type}`).join(`${prevWord}${newImageName}${type}`);
          line = line.split(`"${imageName}${type}`).join(`"${newImageName}${type}`);
          line = line.split(`path = ${imageName}${type}`).join(`path = ${newImageName}${type}`);
          continue;
        }
        if (line.includes(`"${imageName}.`)) { line = line.split(`"${imageName}.`).join(`"${newImageName}.`); continue; }
        if (line.includes(`"${imageName}"`)) { line = line.split(`"${imageName}"`).join(`"${newImageName}"`); continue; }
        if (line.includes(`"${imageName}@2x"`)) { line = line.split(`"${imageName}@2x"`).join(`"${newImageName}@2x"`); continue; }
        if (line.includes(`"${imageName}@3x"`)) { line = line.split(`"${imageName}@3x"`).join(`"${newImageName}@3x"`); }
      }
      return line;
    }
    if (line.includes(`${imageName}${imageType}`)) {
      line = line.split(`${prevWord}${imageName}${imageType}`).join(`${prevWord}${newImageName}${imageType}`);
      line = line.split(`"${imageName}${imageType}`).join(`"${newImageName}${imageType}`);
      line = line.split(`path = ${imageName}${imageType}`).join(`path = ${newImageName}${imageType}`);
      return line;
    }
    if (line.includes(`"${imageName}"`)) return line.split(`"${imageName}"`).join(`"${newImageName}"`);
    if (line.includes(`"${imageName}@2x"`)) return line.split(`"${imageName}@2x"`).join(`"${newImageName}@2x"`);
    if (line.includes(`"${imageName}@3x"`)) return line.split(`"${imageName}@3x"`).join(`"${newImageName}@3x"`);
    return line;
  }
  if (line.includes('imageNamed:@"') && line.includes(imageName)) return line.split(`imageNamed:@"${imageName}`).join(`imageNamed:@"${newImageName}`);
  if (line.includes('imageFromBundle:@"') && line.includes(imageName)) return line.split(`imageFromBundle:@"${imageName}`).join(`imageFromBundle:@"${newImageName}`);
  if (line.includes(`"${imageName}"`)) return line.split(`"${imageName}"`).join(`"${newImageName}"`);
  if (line.includes(`"${imageName}@2x"`)) return line.split(`"${imageName}@2x"`).join(`"${newImageName}@2x"`);
  if (line.includes(`"${imageName}@3x"`)) return line.split(`"${imageName}@3x"`).join(`"${newImageName}@3x"`);
  if (line.includes(`/* ${imageName}@`)) return line.split(`/* ${imageName}@`).join(`/* ${newImageName}@`);
  return line;
}

interface FolderRow { name: string; missName: string; fatherName: string; fatherMissName: string }

/** Resolve a child's renamed folder from its parent name. */
function getFatherMissName(pbxGroups: ReadonlyMap<string, PbxGroupRow>, fatherName: string, childName: string): string {
  for (const partMap of pbxGroups.values()) {
    if (fatherName === partMap.name && partMap.children.includes(childName)) return partMap.missName;
  }
  return '';
}

function isReadableText(relativePathValue: string): boolean {
  return isTextFile(relativePathValue) || classifyLanguage(relativePathValue) !== undefined;
}

function commonRoot(files: WalkEntry[]): string {
  if (files.length === 0) return process.cwd();
  const parts = files.map(entry => entry.absolute.split(sep));
  let common = parts[0]!.slice();
  for (const next of parts.slice(1)) {
    let index = 0;
    while (index < common.length && index < next.length && common[index] === next[index]) index += 1;
    common = common.slice(0, index);
  }
  return common.join(sep) || sep;
}

/** True when a directory must not be renamed. */
function ignoreFolderAbs(absolute: string): boolean {
  return IGNORE_FOLDERS.some(item => absolute.endsWith(item) || absolute.includes(item));
}

/**
 * Path/child map: walk the real directory tree once, recording
 * every child under its parent's "last two components" key and collecting the
 * directories that are eligible for renaming (i.e. not ignored).
 */
function buildPathChildMap(root: string): { pathChildMap: Map<string, Set<string>>; renamableDirs: string[] } {
  const pathChildMap = new Map<string, Set<string>>();
  const renamableDirs: string[] = [];
  const add = (keyPath: string, child: string): void => {
    if (!pathChildMap.has(keyPath)) pathChildMap.set(keyPath, new Set());
    pathChildMap.get(keyPath)!.add(child);
  };
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const childName = name;
      const parent = dirname(absolute);
      const keyPath = `${basename(dirname(parent))}/${basename(parent)}`;
      if (!childName.includes('.DS_Store') && !childName.includes('Icon\r') && !childName.includes('.git')) {
        add(keyPath, childName);
      }
      if (!lstatSync(absolute).isDirectory()) continue;
      if (!ignoreFolderAbs(absolute)) {
        renamableDirs.push(absolute);
        visit(absolute);
      }
    }
  };
  visit(root);
  return { pathChildMap, renamableDirs };
}

/** Project-name folder rename skips these subtrees. */
function skipProjectRenamePath(absolute: string): boolean {
  if (absolute.includes('/.git')) return true;
  if (absolute.includes('.json')) return true;
  if (absolute.includes('/.DS_Store')) return true;
  if (absolute.includes('/Pods') && !absolute.includes('/Pods-')) return true;
  return false;
}

function setEquals(left: ReadonlySet<string>, right: readonly string[]): boolean {
  const rightSet = new Set(right);
  return left.size === rightSet.size && [...left].every(item => rightSet.has(item));
}

/** Resolve a directory's renamed name from the path map. */
function getThisPathMissName(absolute: string, replacePathMap: ReadonlyMap<string, FolderRow>): string | undefined {
  const thisPathName = basename(absolute);
  const fatherPathName = basename(dirname(absolute));
  for (const [keyName, row] of replacePathMap) {
    if (keyName.includes(`&&${thisPathName}`) && (fatherPathName === row.fatherName || fatherPathName === row.fatherMissName)) {
      return row.missName;
    }
  }
  return undefined;
}

/** Remap a file path; its final component (the file name) is never remapped. */
function remapAbsolute(absolute: string, dirRenames: ReadonlyMap<string, string>): string {
  const parts = absolute.split(sep);
  const out: string[] = [];
  let originalPrefix = '';
  for (let index = 0; index < parts.length; index += 1) {
    if (index === 0) { out.push(''); continue; }
    const originalAbs = originalPrefix === '' ? `${sep}${parts[index]}` : `${originalPrefix}${sep}${parts[index]}`;
    if (index === parts.length - 1) { out.push(parts[index]!); break; }
    const target = dirRenames.get(originalAbs);
    out.push(target ? basename(target) : parts[index]!);
    originalPrefix = originalAbs;
  }
  return out.join(sep);
}

/** Remap a directory path, including its final component. */
function remapDirectoryAbsolute(absolute: string, dirRenames: ReadonlyMap<string, string>): string {
  const parts = absolute.split(sep);
  const out: string[] = [];
  let originalPrefix = '';
  for (let index = 0; index < parts.length; index += 1) {
    if (index === 0) { out.push(''); continue; }
    const originalAbs = originalPrefix === '' ? `${sep}${parts[index]}` : `${originalPrefix}${sep}${parts[index]}`;
    const target = dirRenames.get(originalAbs);
    out.push(target ? basename(target) : parts[index]!);
    originalPrefix = originalAbs;
  }
  return out.join(sep);
}

/**
 * Batch entry point: applies the full project-identity rename pipeline to an
 * already-walked project. Directory and image-file renames are applied on disk;
 * text references are rewritten in place. The same seed yields identical output.
 */
export function renameProjectIdentity(files: WalkEntry[], options: ProjectIdentityOptions, seed: string): TransformOutcome {
  const changedPaths: string[] = [];
  if (files.length === 0) return { changed: 0, changedPaths };

  const root = commonRoot(files);
  const folderPrefix = options.folderPrefix ?? '';
  const imagePrefix = options.imagePrefix ?? '';
  const imageAlgorithm = options.imageAlgorithm ?? 0;

  const originalFiles = files.slice();
  const content = new Map<string, string>();
  for (const entry of files) {
    if (isReadableText(entry.relative) && !isImageFile(entry.relative)) {
      content.set(entry.absolute, readFileSync(entry.absolute, 'utf8'));
    }
  }

  const { pathChildMap, renamableDirs } = buildPathChildMap(root);
  const dirRenames = new Map<string, string>();
  const fileRenames = new Map<string, string>();

  // 1. Project name.
  const pbxEntry = files.find(entry => entry.relative.endsWith('/project.pbxproj') && !entry.relative.includes('/Pods/'));
  const projectMatch = pbxEntry?.relative.match(/(?:^|\/)([^/]+)\.xcodeproj\/project\.pbxproj$/);
  const originalProjectName = projectMatch?.[1];
  if (originalProjectName && pbxEntry) {
    const replacement = options.projectName ?? capitalize(deriveHash(seed, 'project-name', originalProjectName).slice(0, 10));
    const oldBridge = `${originalProjectName}-Bridging-Header.h`;
    const newBridge = `${replacement}-Bridging-Header.h`;
    const projectDirs = new Set<string>();
    for (const entry of files) {
      let directory = dirname(entry.absolute);
      while (directory.startsWith(root) && directory !== root) {
        projectDirs.add(directory);
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    for (const directory of [...projectDirs].sort((a, b) => b.length - a.length)) {
      if (skipProjectRenamePath(directory)) continue;
      const name = basename(directory);
      if (name.includes(originalProjectName)) {
        dirRenames.set(directory, join(dirname(directory), name.split(originalProjectName).join(replacement)));
      }
    }
    for (const entry of files) {
      if (skipProjectRenamePath(entry.absolute)) continue;
      const name = basename(entry.absolute);
      if (name.includes(originalProjectName) && !name.endsWith('.h') && !name.endsWith('.m')) {
        fileRenames.set(entry.absolute, join(dirname(entry.absolute), name.split(originalProjectName).join(replacement)));
      } else if (name === oldBridge) {
        fileRenames.set(entry.absolute, join(dirname(entry.absolute), newBridge));
      }
    }
    const pbxContent = content.get(pbxEntry.absolute) ?? readFileSync(pbxEntry.absolute, 'utf8');
    content.set(pbxEntry.absolute, pbxContent.split('\n').map(line => replaceProjectNameInLine(line, originalProjectName, replacement, oldBridge, newBridge)).join('\n'));
  }

  // 2. Folder rename.
  const pbxPath = pbxEntry?.absolute;
  const missPbxprojMap = new Map<string, [string, string]>();
  if (pbxPath && content.has(pbxPath)) {
    const pbxGroups = parsePbxGroups(content.get(pbxPath)!, seed, folderPrefix);
    const replacePathMap = new Map<string, FolderRow>();
    for (const [keyPath, childList] of pathChildMap) {
      for (const [childrenNames, partMap] of pbxGroups) {
        if (!setEquals(childList, childrenNames.split(','))) continue;
        const name = partMap.name;
        const fatherName = keyPath.split('/')[0] ?? '';
        const keyName = `${fatherName}&&${name}`;
        const fatherMissName = getFatherMissName(pbxGroups, fatherName, name);
        replacePathMap.set(keyName, { name, missName: partMap.missName, fatherName, fatherMissName });
        missPbxprojMap.set(partMap.udid, [name, partMap.missName]);
      }
    }
    for (const directory of renamableDirs) {
      const missName = getThisPathMissName(directory, replacePathMap);
      if (missName !== undefined) dirRenames.set(directory, join(dirname(directory), missName));
    }
    content.set(pbxPath, rewritePbxprojForFolders(content.get(pbxPath)!, missPbxprojMap));
  }

  // 3. xcassets image rename.
  const sourceMap = new Map<string, string>();
  const sourceTypeMap = new Map<string, string>();
  for (const entry of originalFiles) {
    if (!entry.relative.includes('.imageset/')) continue;
    if (!isImageFile(entry.relative)) continue;
    const parts = entry.absolute.split(sep);
    const imagesetIndex = parts.findIndex(part => part.endsWith('.imageset'));
    if (imagesetIndex === -1) continue;
    const imagesetAbs = parts.slice(0, imagesetIndex + 1).join(sep);
    const fileName = parts.at(-1)!;
    let stem: string;
    let type: string;
    if (fileName.includes('@')) {
      stem = fileName.split('@')[0]!;
      type = `@${fileName.split('@').at(-1)}`;
    } else {
      stem = fileName.split('.')[0]!;
      type = `.${fileName.split('.').at(-1)}`;
    }
    if (!sourceMap.has(stem)) sourceMap.set(stem, getNewImageName(stem, imagePrefix, seed, imageAlgorithm));
    const newStem = sourceMap.get(stem)!;
    const existingType = sourceTypeMap.get(stem);
    sourceTypeMap.set(stem, existingType && existingType !== type ? `${existingType},${type}` : type);
    const nextName = fileName.includes('@') ? `${newStem}@${fileName.split('@').at(-1)}` : `${newStem}.${fileName.split('.').at(-1)}`;
    fileRenames.set(entry.absolute, join(dirname(entry.absolute), nextName));

    const contentsAbs = join(imagesetAbs, 'Contents.json');
    const contentsBefore = content.get(contentsAbs) ?? (existsSync(contentsAbs) ? readFileSync(contentsAbs, 'utf8') : '');
    if (contentsBefore) {
      let contentsAfter = contentsBefore;
      for (const [oldName, newName] of sourceMap) contentsAfter = contentsAfter.split(`"${oldName}.`).join(`"${newName}.`);
      content.set(contentsAbs, contentsAfter);
    }
  }
  for (const [stem, newStem] of sourceMap) {
    for (const entry of originalFiles) {
      if (!entry.relative.includes('.imageset/')) continue;
      const parts = entry.absolute.split(sep);
      const imagesetIndex = parts.findIndex(part => part.endsWith('.imageset'));
      if (imagesetIndex === -1) continue;
      const imagesetAbs = parts.slice(0, imagesetIndex + 1).join(sep);
      if (basename(imagesetAbs) === `${stem}.imageset`) {
        dirRenames.set(imagesetAbs, join(dirname(imagesetAbs), `${newStem}.imageset`));
      }
    }
  }

  // 3b. Rewrite image references in source/code files.
  for (const entry of originalFiles) {
    if (!isReadableText(entry.relative) || isImageFile(entry.relative)) continue;
    const before = content.get(entry.absolute);
    if (before === undefined) continue;
    let after = before;
    for (const [imageName, newImageName] of sourceMap) {
      after = after.split('\n').map(line => replaceImageNameLine(line, imageName, newImageName, entry.relative, sourceTypeMap.get(imageName))).join('\n');
    }
    content.set(entry.absolute, after);
  }

  // 4. xib/storyboard id + destination and .strings keywords.
  const missMap = new Map<string, string>();
  let keywords: string[] = XIB_KEY_WORDS.slice();
  for (const entry of originalFiles) {
    if (!entry.relative.endsWith('.xib') && !entry.relative.endsWith('.storyboard')) continue;
    const before = content.get(entry.absolute) ?? readFileSync(entry.absolute, 'utf8');
    const after = before.split('\n').map(line => {
      const result = replaceXibStoryboardLine(line, keywords, XIB_PASS_KEY_WORDS, missMap, seed);
      keywords = result.keywords;
      return result.line;
    }).join('\n');
    content.set(entry.absolute, after);
  }
  for (const entry of originalFiles) {
    if (!entry.relative.endsWith('.strings')) continue;
    const before = content.get(entry.absolute) ?? readFileSync(entry.absolute, 'utf8');
    content.set(entry.absolute, replaceStringKeywords(before, missMap));
  }

  // 5. Apply directory renames (deepest first), then file renames, then content.
  const orderedDirRenames = [...dirRenames.entries()].sort((a, b) => b[0].split(sep).length - a[0].split(sep).length);
  for (const [from, to] of orderedDirRenames) {
    if (from === to || !existsSync(from) || existsSync(to)) continue;
    renameSync(from, to);
    changedPaths.push(to);
  }

  for (const [from, to] of fileRenames) {
    const finalFrom = remapAbsolute(from, dirRenames);
    const finalTo = join(remapDirectoryAbsolute(dirname(from), dirRenames), basename(to));
    if (finalFrom === finalTo || !existsSync(finalFrom) || existsSync(finalTo)) continue;
    mkdirSync(dirname(finalTo), { recursive: true });
    renameSync(finalFrom, finalTo);
    changedPaths.push(finalTo);
  }

  for (const entry of originalFiles) {
    const rewritten = content.get(entry.absolute);
    if (rewritten === undefined) continue;
    const finalAbs = remapAbsolute(entry.absolute, dirRenames);
    const previous = existsSync(finalAbs) ? readFileSync(finalAbs, 'utf8') : '';
    if (previous !== rewritten) {
      mkdirSync(dirname(finalAbs), { recursive: true });
      writeFileSync(finalAbs, rewritten);
      changedPaths.push(finalAbs);
    }
  }

  return { changed: changedPaths.length, changedPaths: [...new Set(changedPaths)].map(absolute => relative(root, absolute).split(sep).join('/')) };
}

/**
 * PBX folder rename, reduced to the
 * deterministic core: PBXGroup comment/path renames and relay of `path =` lines.
 * Header-path rewriting (pch/plist/bridging) is folded into the caller only when
 * those paths are part of the folder rename; here the relay covers every group.
 */
function rewritePbxprojForFolders(content: string, missMap: ReadonlyMap<string, [string, string]>): string {
  let relay: [string, string] | null = null;
  const out: string[] = [];
  for (const line of content.split('\n')) {
    if (line.includes('/*') && line.includes('*/')) {
      const lineUdid = line.slice(0, line.indexOf('/*')).split(/\s+/).join('');
      const lineName = line.slice(line.indexOf('/*') + 2, line.indexOf('*/')).split(/\s+/).join('');
      let next = line;
      if (missMap.has(lineUdid)) {
        const pair = missMap.get(lineUdid)!;
        next = line.split(lineName).join(pair[1]);
        if (next.includes('*/ = {')) relay = pair;
      }
      out.push(next);
      continue;
    }
    if (line.includes('path =') && relay !== null) {
      out.push(line.split(relay[0]).join(relay[1]));
      continue;
    }
    if (line.includes('};')) relay = null;
    out.push(line);
  }
  return out.join('\n');
}
