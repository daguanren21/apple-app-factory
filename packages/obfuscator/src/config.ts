import { z } from 'zod';
import type { Framework } from './common.js';

const wordMap = z.record(z.string().min(1), z.string().min(1));
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const CodeOptionsSchema = z.strictObject({
  removeComments: z.boolean().optional(),
  encryptStrings: z.strictObject({ excludes: z.array(z.string().min(1)).default([]) }).optional(),
  renameIdentifiers: z.strictObject({
    mappings: wordMap.default({}),
    patterns: z.array(z.strictObject({ match: z.string().min(1), replacement: z.string().min(1) })).default([]),
    /** Deterministically rename this many discovered declarations to seed-derived tokens. */
    generated: z.number().int().min(0).max(64).optional(),
  }).optional(),
  junkCode: z.strictObject({ lines: z.number().int().min(0).max(32).default(2) }).optional(),
  keywords: wordMap.optional(),
});

const ResourcesOptionsSchema = z.strictObject({
  rename: z.strictObject({
    mappings: wordMap.default({}),
    /** Deterministically rename this many discovered resource stems to seed-derived tokens. */
    generated: z.number().int().min(0).max(128).optional(),
  }).optional(),
  hashPerturb: z.strictObject({ bytes: z.number().int().min(1).max(64) }).optional(),
  images: z.strictObject({
    recolor: z.array(z.strictObject({ from: hexColor, to: hexColor, tolerance: z.number().int().min(0).max(255).optional() })).default([]),
    recolorAll: z.union([
      z.strictObject({ mode: z.literal('hue-shift'), degrees: z.number().finite() }),
      z.strictObject({ mode: z.literal('invert') }),
      z.strictObject({ mode: z.literal('channels'), order: z.string().regex(/^[RGBA]{3,4}$/) }),
    ]).optional(),
    scale: z.strictObject({
      width: z.number().int().min(1).optional(),
      height: z.number().int().min(1).optional(),
      scale: z.number().positive().optional(),
      interpolation: z.enum(['nearest', 'bilinear']).optional(),
    }).optional(),
    flatten: z.strictObject({ bgColor: hexColor.optional() }).optional(),
  }).optional(),
});

const ProjectOptionsSchema = z.strictObject({
  name: z.strictObject({ from: z.string().min(1), to: z.string().min(1) }).optional(),
  directories: z.array(z.string().min(1)).default([]),
  uuids: z.boolean().optional(),
});

const ContentOptionsSchema = z.strictObject({
  sensitiveWords: wordMap.optional(),
  controlColors: z.record(hexColor, hexColor).optional(),
  fontColors: z.record(hexColor, hexColor).optional(),
  dfa: z.strictObject({
    /** Extra sensitive words appended to the built-in lexicon. */
    words: z.array(z.string().min(1)).default([]),
    /** Replacement emitted per matched word character. */
    replace: z.string().min(1).default('*'),
    keywordMix: z.strictObject({ prefix: z.string().min(1).optional() }).optional(),
  }).optional(),
});

/**
 * Options for iOS/Objective-C/Swift projects.
 * Every subsection is optional; empty subsections are no-ops.
 */
const ObjcSymbolsOptionsSchema = z.strictObject({
  algorithmType: z.union([z.literal(0), z.literal(1), z.literal(3)]).optional(),
  methodPrefix: z.string().optional(),
  methodSuffix: z.string().optional(),
  propertyPrefix: z.string().optional(),
  classPrefix: z.string().optional(),
  replaceClassPrefix: z.strictObject({ from: z.string().min(1), to: z.string().min(1) }).optional(),
  replaceMethodPrefix: z.strictObject({ from: z.string().min(1), to: z.string().min(1) }).optional(),
  replacePropertyPrefix: z.strictObject({ from: z.string().min(1), to: z.string().min(1) }).optional(),
  magicColor: z.strictObject({
    enabled: z.boolean().optional(),
    addColor: z.number().optional(),
    textColor: z.number().optional(),
    replaceColor: z.tuple([z.number(), z.number(), z.number()]).optional(),
    alpha: z.tuple([z.number(), z.number()]).optional(),
  }).optional(),
});

const ObjcOptionsSchema = z.strictObject({
  symbols: ObjcSymbolsOptionsSchema.optional(),
  stringEncryption: z.strictObject({
    /** XOR key 0-255; omitted keys are derived deterministically from the seed. */
    encryptionNum: z.number().int().min(0).max(255).optional(),
    /** ObjC macro / Swift function name. Defaults to NNC_NSSTRING / OBF_NSSTRING. */
    encryptedName: z.string().min(1).optional(),
  }).optional(),
  junkCode: z.strictObject({
    amount: z.number().int().min(0).max(32).optional(),
    rubPrefix: z.string().min(1).optional(),
  }).optional(),
  junkFiles: z.strictObject({
    count: z.number().int().min(0).max(64).optional(),
    amount: z.number().int().min(0).max(32).optional(),
    rubPrefix: z.string().min(1).optional(),
    language: z.enum(['OC', 'Swift']).optional(),
  }).optional(),
  cleanResources: z.strictObject({ ignore: z.array(z.string().min(1)).default([]) }).optional(),
  projectIdentity: z.strictObject({
    projectName: z.string().min(1).optional(),
    folderPrefix: z.string().optional(),
    imagePrefix: z.string().optional(),
    imageAlgorithm: z.union([z.literal(0), z.literal(1), z.literal(3)]).optional(),
  }).optional(),
});

const FlutterSymbolsOptionsSchema = z.strictObject({
  prefixWord: z.string().optional(),
  missAlgorithmType: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  classWhiteList: z.array(z.string().min(1)).optional(),
  methodWhiteList: z.array(z.string().min(1)).optional(),
  variableWhiteList: z.array(z.string().min(1)).optional(),
  features: z.strictObject({
    variable: z.boolean().optional(),
    className: z.boolean().optional(),
    method: z.boolean().optional(),
    resourceName: z.boolean().optional(),
    resourceHash: z.boolean().optional(),
    deleteNotes: z.boolean().optional(),
    uuid: z.boolean().optional(),
  }).optional(),
});

export const ObfuscatorConfigSchema = z.strictObject({
  framework: z.enum(['flutter', 'android-java', 'swift', 'react-native', 'expo', 'uni-app', 'mygo']).optional(),
  seed: z.string().min(1).optional(),
  code: CodeOptionsSchema.optional(),
  resources: ResourcesOptionsSchema.optional(),
  project: ProjectOptionsSchema.optional(),
  content: ContentOptionsSchema.optional(),
  /** iOS/Objective-C/Swift options. */
  objc: ObjcOptionsSchema.optional(),
  /** Flutter symbol/resource options. */
  flutter: FlutterSymbolsOptionsSchema.optional(),
}).superRefine((value, context) => {
  if (!value.code && !value.resources && !value.project && !value.content && !value.objc && !value.flutter) {
    context.addIssue({ code: 'custom', path: [], message: 'At least one of code, resources, project, content, objc or flutter must be configured' });
  }
  const rename = value.code?.renameIdentifiers;
  if (rename && !Object.keys(rename.mappings).length && !rename.patterns.length && !rename.generated) {
    context.addIssue({ code: 'custom', path: ['code', 'renameIdentifiers'], message: 'renameIdentifiers needs at least one mapping, pattern or generated count' });
  }
  const resourceRename = value.resources?.rename;
  if (resourceRename && !Object.keys(resourceRename.mappings).length && !resourceRename.generated) {
    context.addIssue({ code: 'custom', path: ['resources', 'rename'], message: 'rename needs at least one mapping or a generated count' });
  }
  const images = value.resources?.images;
  if (images && !images.recolor.length && !images.recolorAll && !images.scale && !images.flatten) {
    context.addIssue({ code: 'custom', path: ['resources', 'images'], message: 'images needs at least one of recolor, recolorAll, scale or flatten' });
  }
  for (const [index, pattern] of (rename?.patterns ?? []).entries()) {
    try { new RegExp(pattern.match); } catch { context.addIssue({ code: 'custom', path: ['code', 'renameIdentifiers', 'patterns', index], message: `Pattern must compile as a regular expression: ${pattern.match}` }); }
  }
  for (const [index, exclude] of (value.code?.encryptStrings?.excludes ?? []).entries()) {
    try { new RegExp(exclude); } catch { context.addIssue({ code: 'custom', path: ['code', 'encryptStrings', 'excludes', index], message: `Exclude pattern must compile as a regular expression: ${exclude}` }); }
  }
});
export type ObfuscatorConfig = z.infer<typeof ObfuscatorConfigSchema>;
export type CodeOptions = NonNullable<ObfuscatorConfig['code']>;
export type ResourcesOptions = NonNullable<ObfuscatorConfig['resources']>;
export type ProjectOptions = NonNullable<ObfuscatorConfig['project']>;
export type ContentOptions = NonNullable<ObfuscatorConfig['content']>;
export type ObjcOptions = NonNullable<ObfuscatorConfig['objc']>;
export type FlutterSymbolsOptions = NonNullable<ObfuscatorConfig['flutter']>;
export type FrameworkOption = NonNullable<ObfuscatorConfig['framework']> | Framework;
