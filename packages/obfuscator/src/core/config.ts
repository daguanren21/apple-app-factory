import { arr, bool, compile, int, lit, map, num, obj, oneOf, opt, str, tuple, union, type Schema, type Static } from '@earendil-works/pi-schema';
import type { Framework } from './common.js';

type ConfigObject = Record<string, unknown>;

function isObject(value: unknown): value is ConfigObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copyMap(value: unknown): unknown {
  if (!isObject(value)) return value;
  const output: ConfigObject = {};
  for (const [key, entry] of Object.entries(value)) if (key !== '__proto__') output[key] = entry;
  return output;
}
function copyArray(value: unknown): unknown {
  return Array.isArray(value) ? [...value] : value;
}

function copyObjectArray(value: unknown): unknown {
  return Array.isArray(value) ? value.map(entry => isObject(entry) ? { ...entry } : entry) : value;
}
function omitUndefined(value: ConfigObject, keys: readonly string[]): void {
  for (const key of keys) if (value[key] === undefined) delete value[key];
}

function keyedMap(value: Schema<string>, key: Schema<string>): Schema<Record<string, string>> {
  return { ...map(value), propertyNames: key };
}

const nonEmptyText = str({ minLength: 1 });
const finiteNumber = num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
const hexColor = str({ pattern: '^#[0-9a-fA-F]{6}$' });
const wordMap = keyedMap(nonEmptyText, str({ minLength: 1 }));
const colorMap = keyedMap(hexColor, hexColor);

const CodeOptionsSchema = obj({
  removeComments: opt(bool()),
  encryptStrings: opt(obj({ excludes: arr(nonEmptyText, { default: [] }) })),
  renameIdentifiers: opt(obj({
    mappings: { ...wordMap, default: {} },
    patterns: { ...arr(obj({ match: nonEmptyText, replacement: nonEmptyText })), default: [] },
    /** Deterministically rename this many discovered declarations to seed-derived tokens. */
    generated: opt(int({ minimum: 0, maximum: 64 })),
  })),
  junkCode: opt(obj({ lines: int({ minimum: 0, maximum: 32, default: 2 }) })),
  keywords: opt(wordMap),
});

const ResourcesOptionsSchema = obj({
  rename: opt(obj({
    mappings: { ...wordMap, default: {} },
    /** Deterministically rename this many discovered resource stems to seed-derived tokens. */
    generated: opt(int({ minimum: 0, maximum: 128 })),
  })),
  hashPerturb: opt(obj({ bytes: int({ minimum: 1, maximum: 64 }) })),
  images: opt(obj({
    recolor: { ...arr(obj({ from: hexColor, to: hexColor, tolerance: opt(int({ minimum: 0, maximum: 255 })) })), default: [] },
    recolorAll: opt(union([
      obj({ mode: lit('hue-shift'), degrees: finiteNumber }),
      obj({ mode: lit('invert') }),
      obj({ mode: lit('channels'), order: str({ pattern: '^[RGBA]{3,4}$' }) }),
    ])),
    scale: opt(obj({
      width: opt(int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
      height: opt(int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
      scale: opt(num({ exclusiveMinimum: 0, maximum: Number.MAX_VALUE })),
      interpolation: opt(oneOf(['nearest', 'bilinear'])),
    })),
    flatten: opt(obj({ bgColor: opt(hexColor) })),
  })),
});

const ProjectOptionsSchema = obj({
  name: opt(obj({ from: nonEmptyText, to: nonEmptyText })),
  directories: arr(nonEmptyText, { default: [] }),
  uuids: opt(bool()),
});

const ContentOptionsSchema = obj({
  sensitiveWords: opt(wordMap),
  controlColors: opt(colorMap),
  fontColors: opt(colorMap),
  dfa: opt(obj({
    /** Extra sensitive words appended to the built-in lexicon. */
    words: { ...arr(nonEmptyText), default: [] },
    /** Replacement emitted per matched word character. */
    replace: str({ minLength: 1, default: '*' }),
    keywordMix: opt(obj({ prefix: opt(nonEmptyText) })),
  })),
});

/**
 * Options for iOS/Objective-C/Swift projects.
 * Every subsection is optional; empty subsections are no-ops.
 */
const ObjcSymbolsOptionsSchema = obj({
  algorithmType: opt(oneOf([0, 1, 3])),
  methodPrefix: opt(str()),
  methodSuffix: opt(str()),
  propertyPrefix: opt(str()),
  classPrefix: opt(str()),
  replaceClassPrefix: opt(obj({ from: nonEmptyText, to: nonEmptyText })),
  replaceMethodPrefix: opt(obj({ from: nonEmptyText, to: nonEmptyText })),
  replacePropertyPrefix: opt(obj({ from: nonEmptyText, to: nonEmptyText })),
  magicColor: opt(obj({
    enabled: opt(bool()),
    addColor: opt(finiteNumber),
    textColor: opt(finiteNumber),
    replaceColor: opt(tuple([finiteNumber, finiteNumber, finiteNumber])),
    alpha: opt(tuple([finiteNumber, finiteNumber])),
  })),
});

const ObjcOptionsSchema = obj({
  symbols: opt(ObjcSymbolsOptionsSchema),
  stringEncryption: opt(obj({
    /** XOR key 0-255; omitted keys are derived deterministically from the seed. */
    encryptionNum: opt(int({ minimum: 0, maximum: 255 })),
    /** ObjC macro / Swift function name. Defaults to NNC_NSSTRING / OBF_NSSTRING. */
    encryptedName: opt(nonEmptyText),
  })),
  junkCode: opt(obj({
    amount: opt(int({ minimum: 0, maximum: 32 })),
    rubPrefix: opt(nonEmptyText),
  })),
  junkFiles: opt(obj({
    count: opt(int({ minimum: 0, maximum: 64 })),
    amount: opt(int({ minimum: 0, maximum: 32 })),
    rubPrefix: opt(nonEmptyText),
    language: opt(oneOf(['OC', 'Swift'])),
  })),
  cleanResources: opt(obj({ ignore: { ...arr(nonEmptyText), default: [] } })),
  projectIdentity: opt(obj({
    projectName: opt(nonEmptyText),
    folderPrefix: opt(str()),
    imagePrefix: opt(str()),
    imageAlgorithm: opt(oneOf([0, 1, 3])),
  })),
});

const FlutterSymbolsOptionsSchema = obj({
  prefixWord: opt(str()),
  missAlgorithmType: opt(oneOf([0, 1, 2, 3])),
  classWhiteList: opt(arr(nonEmptyText)),
  methodWhiteList: opt(arr(nonEmptyText)),
  variableWhiteList: opt(arr(nonEmptyText)),
  features: opt(obj({
    variable: opt(bool()),
    className: opt(bool()),
    method: opt(bool()),
    resourceName: opt(bool()),
    resourceHash: opt(bool()),
    deleteNotes: opt(bool()),
    uuid: opt(bool()),
  })),
});

const NativeObfuscatorConfigSchema = obj({
  framework: opt(oneOf(['flutter', 'android-java', 'swift', 'react-native', 'expo', 'uni-app', 'mygo'])),
  seed: opt(nonEmptyText),
  code: opt(CodeOptionsSchema),
  resources: opt(ResourcesOptionsSchema),
  project: opt(ProjectOptionsSchema),
  content: opt(ContentOptionsSchema),
  /** iOS/Objective-C/Swift options. */
  objc: opt(ObjcOptionsSchema),
  /** Flutter symbol/resource options. */
  flutter: opt(FlutterSymbolsOptionsSchema),
});

export type ObfuscatorConfig = Static<typeof NativeObfuscatorConfigSchema>;
export type CodeOptions = NonNullable<ObfuscatorConfig['code']>;
export type ResourcesOptions = NonNullable<ObfuscatorConfig['resources']>;
export type ProjectOptions = NonNullable<ObfuscatorConfig['project']>;
export type ContentOptions = NonNullable<ObfuscatorConfig['content']>;
export type ObjcOptions = NonNullable<ObfuscatorConfig['objc']>;
export type FlutterSymbolsOptions = NonNullable<ObfuscatorConfig['flutter']>;
export type FrameworkOption = NonNullable<ObfuscatorConfig['framework']> | Framework;

function normalizeCode(input: unknown): unknown {
  if (!isObject(input)) return input;
  const output = { ...input };
  if (output.removeComments === undefined) delete output.removeComments;
  const encryptStrings = output.encryptStrings;
  if (isObject(encryptStrings)) {
    const normalized = { ...encryptStrings };
    normalized.excludes = encryptStrings.excludes === undefined ? [] : copyArray(encryptStrings.excludes);
    output.encryptStrings = normalized;
  } else if (encryptStrings === undefined) delete output.encryptStrings;
  const renameIdentifiers = output.renameIdentifiers;
  if (isObject(renameIdentifiers)) {
    const normalized = { ...renameIdentifiers };
    normalized.mappings = renameIdentifiers.mappings === undefined ? {} : copyMap(renameIdentifiers.mappings);
    normalized.patterns = renameIdentifiers.patterns === undefined ? [] : copyObjectArray(renameIdentifiers.patterns);
    omitUndefined(normalized, ['generated']);
    output.renameIdentifiers = normalized;
  } else if (renameIdentifiers === undefined) delete output.renameIdentifiers;
  const junkCode = output.junkCode;
  if (isObject(junkCode)) {
    const normalized = { ...junkCode };
    normalized.lines = junkCode.lines === undefined ? 2 : junkCode.lines;
    output.junkCode = normalized;
  } else if (junkCode === undefined) delete output.junkCode;
  if (output.keywords !== undefined) output.keywords = copyMap(output.keywords);
  else delete output.keywords;
  return output;
}

function normalizeResources(input: unknown): unknown {
  if (!isObject(input)) return input;
  const output = { ...input };
  const rename = output.rename;
  if (isObject(rename)) {
    const normalized = { ...rename };
    normalized.mappings = rename.mappings === undefined ? {} : copyMap(rename.mappings);
    omitUndefined(normalized, ['generated']);
    output.rename = normalized;
  } else if (rename === undefined) delete output.rename;
  const hashPerturb = output.hashPerturb;
  if (isObject(hashPerturb)) output.hashPerturb = { ...hashPerturb };
  else if (hashPerturb === undefined) delete output.hashPerturb;
  const images = output.images;
  if (isObject(images)) {
    const normalized = { ...images };
    if (images.recolor === undefined) normalized.recolor = [];
    else if (Array.isArray(images.recolor)) normalized.recolor = images.recolor.map(entry => {
      if (!isObject(entry)) return entry;
      const item = { ...entry };
      if (item.tolerance === undefined) delete item.tolerance;
      return item;
    });
    const recolorAll = images.recolorAll;
    if (isObject(recolorAll)) normalized.recolorAll = { ...recolorAll };
    else if (recolorAll === undefined) delete normalized.recolorAll;
    const scale = images.scale;
    if (isObject(scale)) {
      const value = { ...scale };
      omitUndefined(value, ['width', 'height', 'scale', 'interpolation']);
      normalized.scale = value;
    } else if (scale === undefined) delete normalized.scale;
    const flatten = images.flatten;
    if (isObject(flatten)) {
      const value = { ...flatten };
      omitUndefined(value, ['bgColor']);
      normalized.flatten = value;
    } else if (flatten === undefined) delete normalized.flatten;
    output.images = normalized;
  } else if (images === undefined) delete output.images;
  return output;
}

function normalizeProject(input: unknown): unknown {
  if (!isObject(input)) return input;
  const output = { ...input };
  const name = output.name;
  if (isObject(name)) output.name = { ...name };
  else if (name === undefined) delete output.name;
  output.directories = input.directories === undefined ? [] : copyArray(input.directories);
  if (output.uuids === undefined) delete output.uuids;
  return output;
}

function normalizeContent(input: unknown): unknown {
  if (!isObject(input)) return input;
  const output = { ...input };
  if (output.sensitiveWords !== undefined) output.sensitiveWords = copyMap(output.sensitiveWords);
  else delete output.sensitiveWords;
  if (output.controlColors !== undefined) output.controlColors = copyMap(output.controlColors);
  else delete output.controlColors;
  if (output.fontColors !== undefined) output.fontColors = copyMap(output.fontColors);
  else delete output.fontColors;
  const dfa = output.dfa;
  if (isObject(dfa)) {
    const normalized = { ...dfa };
    normalized.words = dfa.words === undefined ? [] : copyArray(dfa.words);
    normalized.replace = dfa.replace === undefined ? '*' : dfa.replace;
    const keywordMix = dfa.keywordMix;
    if (isObject(keywordMix)) {
      const value = { ...keywordMix };
      omitUndefined(value, ['prefix']);
      normalized.keywordMix = value;
    } else if (keywordMix === undefined) delete normalized.keywordMix;
    output.dfa = normalized;
  } else if (dfa === undefined) delete output.dfa;
  return output;
}

function normalizeObjc(input: unknown): unknown {
  if (!isObject(input)) return input;
  const output = { ...input };
  const symbols = output.symbols;
  if (isObject(symbols)) {
    const normalized = { ...symbols };
    omitUndefined(normalized, ['algorithmType', 'methodPrefix', 'methodSuffix', 'propertyPrefix', 'classPrefix']);
    for (const key of ['replaceClassPrefix', 'replaceMethodPrefix', 'replacePropertyPrefix'] as const) {
      const replacement = normalized[key];
      if (isObject(replacement)) normalized[key] = { ...replacement };
      else if (replacement === undefined) delete normalized[key];
    }
    const magicColor = normalized.magicColor;
    if (isObject(magicColor)) {
      const value = { ...magicColor };
      omitUndefined(value, ['enabled', 'addColor', 'textColor']);
      if (value.replaceColor === undefined) delete value.replaceColor;
      else value.replaceColor = copyArray(value.replaceColor);
      if (value.alpha === undefined) delete value.alpha;
      else value.alpha = copyArray(value.alpha);
      normalized.magicColor = value;
    } else if (magicColor === undefined) delete normalized.magicColor;
    output.symbols = normalized;
  } else if (symbols === undefined) delete output.symbols;
  const stringEncryption = output.stringEncryption;
  if (isObject(stringEncryption)) {
    const value = { ...stringEncryption };
    omitUndefined(value, ['encryptionNum', 'encryptedName']);
    output.stringEncryption = value;
  } else if (stringEncryption === undefined) delete output.stringEncryption;
  const junkCode = output.junkCode;
  if (isObject(junkCode)) {
    const value = { ...junkCode };
    omitUndefined(value, ['amount', 'rubPrefix']);
    output.junkCode = value;
  } else if (junkCode === undefined) delete output.junkCode;
  const junkFiles = output.junkFiles;
  if (isObject(junkFiles)) {
    const value = { ...junkFiles };
    omitUndefined(value, ['count', 'amount', 'rubPrefix', 'language']);
    output.junkFiles = value;
  } else if (junkFiles === undefined) delete output.junkFiles;
  const cleanResources = output.cleanResources;
  if (isObject(cleanResources)) {
    output.cleanResources = {
      ...cleanResources,
      ignore: cleanResources.ignore === undefined ? [] : copyArray(cleanResources.ignore),
    };
  } else if (cleanResources === undefined) delete output.cleanResources;
  const projectIdentity = output.projectIdentity;
  if (isObject(projectIdentity)) {
    const value = { ...projectIdentity };
    omitUndefined(value, ['projectName', 'folderPrefix', 'imagePrefix', 'imageAlgorithm']);
    output.projectIdentity = value;
  } else if (projectIdentity === undefined) delete output.projectIdentity;
  return output;
}

function normalizeFlutter(input: unknown): unknown {
  if (!isObject(input)) return input;
  const output = { ...input };
  for (const key of ['prefixWord', 'missAlgorithmType'] as const) if (output[key] === undefined) delete output[key];
  for (const key of ['classWhiteList', 'methodWhiteList', 'variableWhiteList'] as const) {
    if (output[key] === undefined) delete output[key];
    else output[key] = copyArray(output[key]);
  }
  const features = output.features;
  if (isObject(features)) {
    const value = { ...features };
    omitUndefined(value, ['variable', 'className', 'method', 'resourceName', 'resourceHash', 'deleteNotes', 'uuid']);
    output.features = value;
  } else if (features === undefined) delete output.features;
  return output;
}

function normalizeConfig(input: unknown): unknown {
  if (!isObject(input)) return input;
  const output = { ...input };
  if (output.framework === undefined) delete output.framework;
  if (output.seed === undefined) delete output.seed;
  if (output.code !== undefined) output.code = normalizeCode(output.code);
  else delete output.code;
  if (output.resources !== undefined) output.resources = normalizeResources(output.resources);
  else delete output.resources;
  if (output.project !== undefined) output.project = normalizeProject(output.project);
  else delete output.project;
  if (output.content !== undefined) output.content = normalizeContent(output.content);
  else delete output.content;
  if (output.objc !== undefined) output.objc = normalizeObjc(output.objc);
  else delete output.objc;
  if (output.flutter !== undefined) output.flutter = normalizeFlutter(output.flutter);
  else delete output.flutter;
  return output;
}

export interface ObfuscatorConfigIssue {
  readonly path: (string | number)[];
  readonly message: string;
  readonly keyword?: string;
}

export class ObfuscatorConfigError extends Error {
  constructor(readonly issues: readonly ObfuscatorConfigIssue[]) {
    super(issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '));
    this.name = 'ObfuscatorConfigError';
  }
}

function decodePointer(pointer: string): (string | number)[] {
  if (pointer.length === 0) return [];
  return pointer.slice(1).split('/').map(segment => {
    const decoded = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    return /^(?:0|[1-9]\d*)$/.test(decoded) ? Number(decoded) : decoded;
  });
}

function structuralIssues(value: unknown): ObfuscatorConfigIssue[] {
  return compiled.errors(value).map(error => ({
    path: decodePointer(error.path),
    keyword: error.keyword,
    message: error.message,
  }));
}

function semanticIssues(value: ObfuscatorConfig): ObfuscatorConfigIssue[] {
  const issues: ObfuscatorConfigIssue[] = [];
  if (!value.code && !value.resources && !value.project && !value.content && !value.objc && !value.flutter) {
    issues.push({ path: [], message: 'At least one of code, resources, project, content, objc or flutter must be configured' });
  }
  const rename = value.code?.renameIdentifiers;
  if (rename && !Object.keys(rename.mappings).length && !rename.patterns.length && !rename.generated) {
    issues.push({ path: ['code', 'renameIdentifiers'], message: 'renameIdentifiers needs at least one mapping, pattern or generated count' });
  }
  const resourceRename = value.resources?.rename;
  if (resourceRename && !Object.keys(resourceRename.mappings).length && !resourceRename.generated) {
    issues.push({ path: ['resources', 'rename'], message: 'rename needs at least one mapping or a generated count' });
  }
  const images = value.resources?.images;
  if (images && !images.recolor.length && !images.recolorAll && !images.scale && !images.flatten) {
    issues.push({ path: ['resources', 'images'], message: 'images needs at least one of recolor, recolorAll, scale or flatten' });
  }
  for (const [index, pattern] of (rename?.patterns ?? []).entries()) {
    try { new RegExp(pattern.match); }
    catch { issues.push({ path: ['code', 'renameIdentifiers', 'patterns', index], message: `Pattern must compile as a regular expression: ${pattern.match}` }); }
  }
  for (const [index, exclude] of (value.code?.encryptStrings?.excludes ?? []).entries()) {
    try { new RegExp(exclude); }
    catch { issues.push({ path: ['code', 'encryptStrings', 'excludes', index], message: `Exclude pattern must compile as a regular expression: ${exclude}` }); }
  }
  return issues;
}

const compiled = compile(NativeObfuscatorConfigSchema);

const orderBranchChecks = new WeakMap<object, (value: unknown) => boolean>();

// The CLI hashes parsed config JSON for its implicit seed. Reorder the owned
// containers in place; dynamic mapping order and the owner's input stay intact.
function preserveConfigOrder(schema: Schema, value: unknown): void {
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) if (isObject(branch)) {
      let check = orderBranchChecks.get(branch);
      if (!check) { check = compile(branch).check; orderBranchChecks.set(branch, check); }
      if (check(value)) { preserveConfigOrder(branch, value); return; }
    }
  } else if (Array.isArray(value) && isObject(schema.items)) {
    for (const entry of value) preserveConfigOrder(schema.items, entry);
  } else if (isObject(value) && isObject(schema.properties)) {
    for (const [key, property] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key) || !isObject(property)) continue;
      const entry = value[key];
      preserveConfigOrder(property, entry);
      delete value[key];
      Object.defineProperty(value, key, { value: entry, enumerable: true, writable: true, configurable: true });
    }
  }
}

function parseConfig(input: unknown): ObfuscatorConfig {
  const prepared = normalizeConfig(input);
  if (!compiled.check(prepared)) throw new ObfuscatorConfigError(structuralIssues(prepared));
  const output = prepared;
  const semantic = semanticIssues(output);
  if (semantic.length > 0) throw new ObfuscatorConfigError(semantic);
  preserveConfigOrder(NativeObfuscatorConfigSchema, output);
  return output;
}

export const ObfuscatorConfigSchema = {
  schema: NativeObfuscatorConfigSchema,
  parse: parseConfig,
  safeParse(input: unknown): { success: true; data: ObfuscatorConfig } | { success: false; error: ObfuscatorConfigError } {
    try { return { success: true, data: parseConfig(input) }; }
    catch (error) {
      if (error instanceof ObfuscatorConfigError) return { success: false, error };
      throw error;
    }
  },
};

export type NativeObfuscatorConfig = Static<typeof NativeObfuscatorConfigSchema>;
