import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Framework, TransformOutcome, WalkEntry } from './common.js';
import { deriveToken, deriveUuid, isReferenceCarrier, replaceWholeWords, writeIfChanged } from './common.js';

/**
 * Deterministic project-level transforms: display-name scrubbing in framework config
 * files, seeded directory renames with reference rewrites, and UUID remapping.
 */

/** Framework configuration files where the app display name legitimately lives. */
const CONFIG_FILES: Readonly<Record<Framework, readonly string[]>> = {
  flutter: ['pubspec.yaml'],
  'android-java': ['AndroidManifest.xml', 'strings.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties'],
  swift: ['Info.plist', 'project.pbxproj'],
  'react-native': ['app.json', 'package.json'],
  expo: ['app.json', 'app.config.json', 'app.config.js', 'package.json'],
  'uni-app': ['manifest.json', 'pages.json'],
  mygo: [],
};

const XCCONFIG_SUFFIX = '.xcconfig';

function isConfigFile(relative: string, framework: Framework): boolean {
  const base = relative.slice(relative.lastIndexOf('/') + 1);
  if (framework === 'swift' && base.endsWith(XCCONFIG_SUFFIX)) return true;
  return CONFIG_FILES[framework].includes(base);
}

/**
 * Replace the app's display name (`from` -> `to`, whole-word) inside framework config
 * files only. Code identifiers and resource payloads are left to code/content transforms.
 */
export function renameProjectConfig(files: WalkEntry[], framework: Framework, name: { from: string; to: string }): TransformOutcome {
  const changedPaths: string[] = [];
  let changed = 0;
  for (const entry of files) {
    if (!isConfigFile(entry.relative, framework)) continue;
    const before = readFileSync(entry.absolute, 'utf8');
    const result = replaceWholeWords(before, { [name.from]: name.to });
    if (result.count === 0) continue;
    if (writeIfChanged(entry, result.text)) {
      changed += 1;
      changedPaths.push(entry.relative);
    }
  }
  return { changed, changedPaths };
}

/**
 * Rename the named directories to seed-derived tokens and rewrite path references in
 * text/code files, keeping the project buildable. Empty source directories remain on
 * disk (their contents moved); collisions leave the colliding file at its old path.
 */
export function obfuscateDirectories(root: string, files: WalkEntry[], directories: string[], seed: string): TransformOutcome {
  const wanted = new Set(directories.filter(name => name.length > 0));
  if (!wanted.size) return { changed: 0, changedPaths: [] };
  const mapping = new Map<string, string>();
  for (const name of wanted) mapping.set(name, deriveToken(seed, 'directory', name));

  const pathRenames = new Map<string, string>();
  const occupied = new Set(files.map(entry => entry.relative));
  const applied = new Map<string, string>();
  for (const entry of files) {
    const segments = entry.relative.split('/');
    let renamed = false;
    const next = segments.map(segment => {
      const mapped = mapping.get(segment);
      if (mapped !== undefined) { renamed = true; return mapped; }
      return segment;
    });
    if (!renamed) continue;
    const target = next.join('/');
    if (occupied.has(target)) continue; // collision: keep the original path
    pathRenames.set(entry.relative, target);
    occupied.add(target);
    for (const [segment, mapped] of segments.map((segment, index) => [segment, next[index]!] as const)) {
      if (mapped !== segment) applied.set(segment, mapped);
    }
  }

  const changedPaths: string[] = [];
  let changed = 0;
  if (applied.size) {
    const words: Record<string, string> = {};
    for (const [from, to] of applied) words[from] = to;
    for (const entry of files) {
      if (!isReferenceCarrier(entry.relative)) continue;
      const before = readFileSync(entry.absolute, 'utf8');
      const result = replaceWholeWords(before, words);
      if (result.count === 0) continue;
      if (writeIfChanged(entry, result.text)) {
        changed += 1;
        changedPaths.push(entry.relative);
      }
    }
  }
  for (const [from, to] of pathRenames) {
    const source = join(root, from);
    const target = join(root, to);
    if (!existsSync(source)) continue;
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
    changed += 1;
    changedPaths.push(to);
  }
  return { changed, changedPaths };
}

const UUID_PATTERN = /(?<![0-9A-Fa-f])[0-9A-F]{24}(?![0-9A-Fa-f])/g;

/**
 * Remap every 24-char uppercase-hex identifier (Xcode UUID shape) in text/code files.
 * The same original value always maps to the same seed-derived value, preserving the
 * internal reference graph of project.pbxproj and similar files.
 */
export function remapUuids(files: WalkEntry[], seed: string): TransformOutcome {
  const changedPaths: string[] = [];
  let changed = 0;
  for (const entry of files) {
    if (!isReferenceCarrier(entry.relative)) continue;
    const before = readFileSync(entry.absolute, 'utf8');
    if (!UUID_PATTERN.test(before)) continue;
    UUID_PATTERN.lastIndex = 0;
    const replacements = new Map<string, string>();
    const next = before.replace(UUID_PATTERN, original => {
      let mapped = replacements.get(original);
      if (mapped === undefined) {
        mapped = deriveUuid(seed, original);
        replacements.set(original, mapped);
      }
      return mapped;
    });
    if (writeIfChanged(entry, next)) {
      changed += 1;
      changedPaths.push(entry.relative);
    }
  }
  return { changed, changedPaths };
}
