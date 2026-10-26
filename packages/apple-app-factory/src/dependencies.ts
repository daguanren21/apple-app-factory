import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { canonicalPath, inside } from './config.js';

export const GENERATED_PATHS = new Set([
  '.git', '.dart_tool', '.idea', '.factory-input', '.factory-cache', 'build',
  '.flutter-plugins-dependencies', 'ios/Pods', 'ios/.symlinks',
  'ios/Flutter/Generated.xcconfig', 'ios/Flutter/flutter_export_environment.sh', 'ios/Flutter/ephemeral',
]);

export function isGeneratedPath(path: string): boolean {
  let candidate = sep === '/' ? path : path.split(sep).join('/');
  while (candidate) {
    if (GENERATED_PATHS.has(candidate)) return true;
    const slash = candidate.lastIndexOf('/');
    if (slash < 0) return false;
    candidate = candidate.slice(0, slash);
  }
  return false;
}

function mapping(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected a YAML mapping in ${path}; run flutter pub get after repairing the dependency metadata`);
  return value as Record<string, unknown>;
}

function yaml(path: string): Record<string, unknown> {
  const document = parseDocument(readFileSync(path, 'utf8'));
  if (document.errors.length) throw new Error(`Cannot parse dependency metadata at ${path}: ${document.errors.map(error => error.message).join('; ')}`);
  return mapping(document.toJS(), path);
}

export function validateLocalDependencies(root: string): void {
  const manifest = join(root, 'pubspec.yaml');
  if (!existsSync(manifest)) return;
  const workspace = canonicalPath(root);
  const rootSpec = yaml(manifest);
  const overridesFile = join(root, 'pubspec_overrides.yaml');
  const overrides = {
    ...mapping(rootSpec.dependency_overrides, manifest),
    ...mapping(existsSync(overridesFile) ? yaml(overridesFile).dependency_overrides : undefined, overridesFile),
  };
  const localPackages = new Map<string, string>();
  const immutablePackages = new Set<string>();
  const visited = new Set<string>();

  function owned(path: string): string {
    const absolute = resolve(path);
    const lexical = relative(resolve(root), absolute);
    const actual = relative(workspace, canonicalPath(absolute));
    if (isAbsolute(lexical) || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(actual) || actual === '..' || actual.startsWith(`..${sep}`) || isGeneratedPath(lexical) || isGeneratedPath(actual)) {
      throw new Error(`Local dependency ${path} is outside fingerprinted workspace source; move the package into a non-generated workspace directory and run flutter pub get`);
    }
    if (lexical) inside(root, absolute);
    return absolute;
  }

  function pathDependency(name: string, value: unknown, directory: string): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const dependency = value as Record<string, unknown>;
    if (!Object.hasOwn(dependency, 'path')) return;
    if (typeof dependency.path !== 'string' || !dependency.path) throw new Error(`Local dependency ${name} in ${join(directory, 'pubspec.yaml')} requires a nonempty path`);
    if (isAbsolute(dependency.path)) throw new Error(`Local dependency ${name} in ${join(directory, 'pubspec.yaml')} requires a workspace-relative path so verified source can be copied to a successor`);
    const packageRoot = owned(resolve(directory, dependency.path));
    const previous = localPackages.get(name);
    if (previous && canonicalPath(previous) !== canonicalPath(packageRoot)) throw new Error(`Local dependency ${name} resolves to conflicting package directories; run flutter pub get before verification`);
    localPackages.set(name, packageRoot);
    visit(packageRoot, false);
  }

  function visit(directory: string, isRoot: boolean): void {
    directory = owned(directory);
    if (visited.has(directory)) return;
    visited.add(directory);
    const path = join(directory, 'pubspec.yaml');
    const spec = isRoot ? rootSpec : yaml(path);
    const dependencies = { ...mapping(spec.dependencies, path), ...(isRoot ? mapping(spec.dev_dependencies, path) : {}) };
    for (const [name, dependency] of Object.entries(dependencies)) {
      const overridden = Object.hasOwn(overrides, name);
      pathDependency(name, overridden ? overrides[name] : dependency, overridden ? root : directory);
    }
  }


  visit(root, true);
  const lockFile = join(root, 'pubspec.lock');
  if (existsSync(lockFile)) {
    const packages = mapping(yaml(lockFile).packages, lockFile);
    for (const [name, value] of Object.entries(packages)) {
      const entry = mapping(value, lockFile);
      if (entry.source === 'path') {
        const description = mapping(entry.description, lockFile);
        pathDependency(name, { path: description.path }, root);
      } else if (entry.source === 'hosted' || entry.source === 'sdk' || entry.source === 'git') immutablePackages.add(name);
    }
  }

  const packageConfig = join(root, '.dart_tool', 'package_config.json');
  if (!existsSync(packageConfig)) return;
  const config: unknown = JSON.parse(readFileSync(packageConfig, 'utf8'));
  const packages = mapping(config, packageConfig).packages;
  if (!Array.isArray(packages)) throw new Error(`Invalid package resolution at ${packageConfig}; run flutter pub get before verification`);
  for (const value of packages) {
    const entry = mapping(value, packageConfig);
    if (typeof entry.name !== 'string' || typeof entry.rootUri !== 'string') throw new Error(`Invalid package resolution at ${packageConfig}; run flutter pub get before verification`);
    if (immutablePackages.has(entry.name) && !localPackages.has(entry.name)) continue;
    const uri = new URL(entry.rootUri, pathToFileURL(packageConfig));
    if (uri.protocol !== 'file:') throw new Error(`Cannot establish local package source for ${entry.name} in ${packageConfig}; run flutter pub get before verification`);
    const packageRoot = owned(fileURLToPath(uri));
    const declared = localPackages.get(entry.name);
    if (declared && canonicalPath(declared) !== canonicalPath(packageRoot)) throw new Error(`Resolved local dependency ${entry.name} differs from its declared path; run flutter pub get before verification`);
    visit(packageRoot, canonicalPath(packageRoot) === workspace);
  }
}

export function dependencyDigest(root: string): string {
  const path = join(root, '.dart_tool', 'package_config.json');
  const hash = createHash('sha256').update('factory-dependency-resolution-v1\0');
  if (!existsSync(path)) return hash.update('missing').digest('hex');
  const config: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const invalid = () => new Error(`Invalid package resolution at ${path}; run flutter pub get before verification`);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalid();
  const metadata = config as Record<string, unknown>;
  if (!Number.isInteger(metadata.configVersion) || !Array.isArray(metadata.packages)) throw invalid();
  const names = new Set<string>();

  function normalized(uri: URL): string {
    if (uri.protocol !== 'file:') return uri.href;
    const canonical = pathToFileURL(canonicalPath(fileURLToPath(uri)));
    if (uri.pathname.endsWith('/') && !canonical.pathname.endsWith('/')) canonical.pathname += '/';
    canonical.search = uri.search;
    canonical.hash = uri.hash;
    return canonical.href;
  }

  const packages = metadata.packages.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    const entry = value as Record<string, unknown>;
    if (typeof entry.name !== 'string' || !entry.name || names.has(entry.name) || typeof entry.rootUri !== 'string' || (entry.packageUri !== undefined && typeof entry.packageUri !== 'string') || (entry.languageVersion !== undefined && typeof entry.languageVersion !== 'string')) throw invalid();
    names.add(entry.name);
    const rootUri = new URL(entry.rootUri, pathToFileURL(path));
    // Dart treats both URI fields as directories even without a trailing slash.
    if (!rootUri.pathname.endsWith('/')) rootUri.pathname += '/';
    const packageUri = new URL(entry.packageUri ?? '', rootUri);
    if (!packageUri.pathname.endsWith('/')) packageUri.pathname += '/';
    return { name: entry.name, rootUri: normalized(rootUri), packageUri: normalized(packageUri), languageVersion: entry.languageVersion ?? null };
  }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return hash.update(JSON.stringify({ configVersion: metadata.configVersion, packages })).digest('hex');
}
