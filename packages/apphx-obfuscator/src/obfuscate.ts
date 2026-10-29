import { readFileSync } from 'node:fs';
import type { Framework, TransformOutcome } from './common.js';
import { basenameWithoutExtension, classifyLanguage, deriveHash, deriveToken, isGeneratedCode, isResourceFile, walkProject, writeIfChanged } from './common.js';
import type { ObfuscatorConfig } from './config.js';
import { extractDeclaredIdentifiers, generateIdentifierMappings, transformCode } from './code.js';
import { applyResourceRenames, perturbImageHashes, planResourceRenames, recolorImages } from './resources.js';
import { obfuscateDirectories, remapUuids, renameProjectConfig } from './project.js';
import { filterSensitiveWords, recolorSourceColors } from './content.js';

export interface ObfuscationReport {
  /** Distinct owned files or directories whose content, path or binary payload changed. */
  changedFiles: number;
  /** Per-feature counts of changed files (or renamed entries). */
  transforms: Record<string, number>;
  skipped: { generated: number; unsupported: number };
}

/**
 * Deterministic in-place obfuscation of an owned project directory. Pass order is fixed so
 * reference-bearing renames happen before string/code transforms consume final names:
 * project config -> resource renames -> resource payloads -> content -> code.
 */
export function applyObfuscation(root: string, config: ObfuscatorConfig, seed: string, framework: Framework): ObfuscationReport {
  const changed = new Set<string>();
  const transforms: Record<string, number> = {};
  let unsupported = 0;
  const record = (name: string, outcome: TransformOutcome): void => {
    transforms[name] = outcome.changed;
    unsupported += outcome.unsupported ?? 0;
    for (const relative of outcome.changedPaths) changed.add(relative);
  };

  let walked = walkProject(root);

  // 1. Project configuration transforms.
  if (config.project?.name) record('projectName', renameProjectConfig(walked.files, framework, config.project.name));
  if (config.project?.directories.length) {
    record('projectDirectories', obfuscateDirectories(root, walked.files, config.project.directories, seed));
    walked = walkProject(root);
  }
  if (config.project?.uuids) record('projectUuids', remapUuids(walked.files, seed));

  // 2. Resource transforms (path changes before content transforms).
  if (config.resources?.rename) {
    const mappings = { ...config.resources.rename.mappings };
    if (config.resources.rename.generated) {
      const stems = [...new Set(walked.files.filter(entry => isResourceFile(entry.relative)).map(entry => basenameWithoutExtension(entry.relative)))];
      const selected = stems
        .map(stem => ({ stem, score: deriveHash(seed, 'resource-select', stem) }))
        .sort((a, b) => a.score < b.score ? -1 : a.score > b.score ? 1 : 0)
        .slice(0, config.resources.rename.generated);
      for (const { stem } of selected) mappings[stem] = deriveToken(seed, 'resource', stem);
    }
    const plan = planResourceRenames(walked.files, mappings);
    record('resourceRename', applyResourceRenames(root, walked.files, plan));
    walked = walkProject(root);
  }
  if (config.resources?.hashPerturb) record('resourceHash', perturbImageHashes(walked.files, config.resources.hashPerturb.bytes, seed));
  if (config.resources?.images) record('imageRecolor', recolorImages(walked.files, config.resources.images, seed));

  // 3. Content transforms.
  if (config.content?.sensitiveWords) record('sensitiveWords', filterSensitiveWords(walked.files, config.content.sensitiveWords));
  if (config.content?.controlColors || config.content?.fontColors) {
    record('sourceColors', recolorSourceColors(walked.files, config.content.controlColors, config.content.fontColors));
  }

  // 4. Code transforms.
  if (config.code) {
    // Seed-generated renames need a whole-project pass first: collect declared names, pick a
    // seeded selection, then rename every reference consistently (except generated code files,
    // whose serializers must keep referencing the original names).
    let generatedMappings: Record<string, string> = {};
    if (config.code.renameIdentifiers?.generated) {
      const declared: string[] = [];
      for (const entry of walked.files) {
        if (isGeneratedCode(entry.relative)) continue;
        const language = classifyLanguage(entry.relative);
        if (language) declared.push(...extractDeclaredIdentifiers(readFileSync(entry.absolute, 'utf8'), language));
      }
      generatedMappings = generateIdentifierMappings(declared, config.code.renameIdentifiers.generated, seed);
    }
    const hasGenerated = Object.keys(generatedMappings).length > 0;
    let count = 0;
    for (const entry of walked.files) {
      const language = classifyLanguage(entry.relative);
      if (!language) continue;
      const options = hasGenerated && config.code.renameIdentifiers && !isGeneratedCode(entry.relative)
        ? { ...config.code, renameIdentifiers: { ...config.code.renameIdentifiers, mappings: { ...generatedMappings, ...config.code.renameIdentifiers.mappings } } }
        : config.code;
      const before = readFileSync(entry.absolute, 'utf8');
      const next = transformCode(before, language, options, seed, entry.relative);
      if (next !== before) {
        writeIfChanged(entry, next);
        count += 1;
        changed.add(entry.relative);
      }
    }
    transforms.code = count;
  }

  return { changedFiles: changed.size, transforms, skipped: { generated: walked.skipped, unsupported } };
}
