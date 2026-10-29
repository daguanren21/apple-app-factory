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
    recolor: z.array(z.strictObject({ from: hexColor, to: hexColor, tolerance: z.number().int().min(0).max(255).optional() })).min(1),
    recolorAll: z.union([
      z.strictObject({ mode: z.literal('hue-shift'), degrees: z.number().finite() }),
      z.strictObject({ mode: z.literal('invert') }),
      z.strictObject({ mode: z.literal('channels'), order: z.string().regex(/^[RGBA]{3,4}$/) }),
    ]).optional(),
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
});

export const ObfuscatorConfigSchema = z.strictObject({
  framework: z.enum(['flutter', 'android-java', 'swift', 'react-native', 'expo', 'uni-app', 'mygo']).optional(),
  seed: z.string().min(1).optional(),
  code: CodeOptionsSchema.optional(),
  resources: ResourcesOptionsSchema.optional(),
  project: ProjectOptionsSchema.optional(),
  content: ContentOptionsSchema.optional(),
}).superRefine((value, context) => {
  if (!value.code && !value.resources && !value.project && !value.content) {
    context.addIssue({ code: 'custom', path: [], message: 'At least one of code, resources, project or content must be configured' });
  }
  const rename = value.code?.renameIdentifiers;
  if (rename && !Object.keys(rename.mappings).length && !rename.patterns.length && !rename.generated) {
    context.addIssue({ code: 'custom', path: ['code', 'renameIdentifiers'], message: 'renameIdentifiers needs at least one mapping, pattern or generated count' });
  }
  const resourceRename = value.resources?.rename;
  if (resourceRename && !Object.keys(resourceRename.mappings).length && !resourceRename.generated) {
    context.addIssue({ code: 'custom', path: ['resources', 'rename'], message: 'rename needs at least one mapping or a generated count' });
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
export type FrameworkOption = NonNullable<ObfuscatorConfig['framework']> | Framework;
