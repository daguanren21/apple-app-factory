import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { canonicalPath, inside } from './config.js';
import type { Framework } from './schemas.js';
import { goDependencyInputs } from './go-dependencies.js';

export const GENERATED_PATHS = new Set([
  '.git', '.dart_tool', '.idea', '.factory-input', '.factory-cache', 'build',
  '.flutter-plugins-dependencies', 'ios/Pods', 'ios/.symlinks',
  'ios/Flutter/Generated.xcconfig', 'ios/Flutter/flutter_export_environment.sh', 'ios/Flutter/ephemeral',
]);

export function isGeneratedPath(path: string, framework?: Framework): boolean {
  let candidate = sep === '/' ? path : path.split(sep).join('/');
  candidate = candidate.replace(/^\.\//, '').replace(/\/$/, '');
  const parts = candidate.split('/');
  if (framework === 'mygo') {
    // MyGo owns only its actual caches and root/selected-project outputs. In
    // particular lib/build, Pods, .build and .gradle remain ordinary source.
    return ['.git', '.idea', '.factory-input', '.factory-cache', 'build', 'dist'].includes(parts[0]!)
      || parts.includes('.mygo') || parts.includes('node_modules')
      || parts.some((part, index) => part === '.yarn' && ['cache', 'unplugged', 'install-state.gz'].includes(parts[index + 1] ?? ''));
  }
  if (framework === 'flutter' && (parts.includes('.dart_tool') || parts.includes('.gradle'))) return true;
  // Exclusions are anchored: owned paths such as lib/build remain source.
  if (['.git', '.idea', '.factory-input', '.factory-cache', 'build'].includes(parts[0]!)) return true;
  if (framework && framework !== 'flutter') {
    const javascript = framework === 'react-native' || framework === 'expo' || framework === 'uni-app';
    if (javascript && parts.includes('node_modules')) return true;
    if (framework !== 'swift' && parts.includes('.gradle')) return true;
    if (framework !== 'android-java' && parts.includes('Pods')) return true;
    if (framework !== 'android-java' && (parts.includes('.build') || parts[0] === 'DerivedData')) return true;
    if (framework !== 'swift' && /^(?:android\/)?(?:app\/)?build(?:\/|$)/.test(candidate)) return true;
    if (framework !== 'android-java' && /^ios\/(?:build|DerivedData)(?:\/|$)/.test(candidate)) return true;
    if (javascript && /^\.yarn\/(?:cache|unplugged|install-state\.gz)(?:\/|$)/.test(candidate)) return true;
    if (framework === 'expo' && /^\.expo(?:\/|$)/.test(candidate)) return true;
    if (framework === 'uni-app' && /^(?:unpackage|dist)(?:\/|$)/.test(candidate)) return true;
    return false;
  }
  while (candidate) {
    if (GENERATED_PATHS.has(candidate)) return true;
    const slash = candidate.lastIndexOf('/');
    if (slash < 0) return false;
    candidate = candidate.slice(0, slash);
  }
  return false;
}

function manifestCode(path: string, ruby = false): string {
  return readFileSync(path, 'utf8').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|#[^\r\n]*/g, token => {
    if (token.startsWith('"') || token.startsWith("'") || (token.startsWith('#') && !ruby)) return token;
    return ' ';
  });
}

// Consume complete literals before looking for declarations, including multiline
// Gradle diagnostics. Their contents never establish source ownership.
const GRADLE_TOKENS = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g;
function gradleCode(path: string): string {
  return readFileSync(path, 'utf8').replace(GRADLE_TOKENS, token =>
    token.startsWith('/') ? token.replace(/[^\r\n]/g, ' ') : token);
}
function gradlePattern(expression: RegExp): RegExp {
  return new RegExp(`${GRADLE_TOKENS.source}|${expression.source}`, 'g');
}

/** Workspace-relative build outputs for statically declared, real Gradle modules. */
export function generatedModulePaths(root: string, framework: Framework, directory = '.'): ReadonlySet<string> {
  if (!['android-java', 'react-native', 'expo', 'uni-app'].includes(framework)) return new Set<string>();
  const outputs = new Set<string>();
  const visited = new Set<string>();
  function underOutput(path: string): boolean {
    const portable = path.split(sep).join('/');
    for (const output of outputs) if (portable === output || portable.startsWith(`${output}/`)) return true;
    return false;
  }
  function registerBuildOutput(absolute: string): void {
    for (const build of ['build.gradle', 'build.gradle.kts']) {
      const manifest = join(absolute, build);
      const stat = lstatSync(manifest, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) throw new Error(`Gradle module manifest cannot be a symlink: ${manifest}`);
      if (stat?.isFile()) outputs.add(relative(root, join(absolute, 'build')).split(sep).join('/'));
    }
  }
  function visit(current: string): void {
    current = resolve(current);
    if (visited.has(current)) return;
    if (current !== resolve(root)) inside(root, current);
    const path = relative(root, current);
    if (generatedInProject(path, framework, directory) || underOutput(path)) return;
    if (path !== relative(canonicalPath(root), canonicalPath(current))) throw new Error(`Gradle build directory cannot be a source symlink: ${current}`);
    visited.add(current);
    registerBuildOutput(current);
    for (const name of ['settings.gradle', 'settings.gradle.kts']) {
      const settings = join(current, name);
      const stat = lstatSync(settings, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Gradle settings must be a regular source file: ${settings}`);
      const text = gradleCode(settings);
      const modules = new Map<string, string>();
      for (const include of text.matchAll(gradlePattern(/\binclude\s*(?:\(([^)]*)\)|([^\r\n;]+))/))) {
        const argumentsText = include[1] ?? include[2];
        if (argumentsText === undefined || !/^\s*(?:(?:"[:\w.-]+"|'[:\w.-]+')\s*,?\s*)+$/.test(argumentsText)) continue;
        for (const match of argumentsText.matchAll(/["'](:?[\w.-]+(?::[\w.-]+)*)["']/g)) {
          const id = match[1]!.replace(/^:/, '');
          modules.set(id, id.split(':').join('/'));
        }
      }
      for (const match of text.matchAll(gradlePattern(/\bproject\s*\(\s*["'](:?[\w.-]+(?::[\w.-]+)*)["']\s*\)\s*\.projectDir\s*=\s*file\s*\(\s*(?:"([^"\\$]+)"|'([^'\\]+)')\s*\)/))) {
        if (match[1] === undefined) continue;
        const id = match[1].replace(/^:/, '');
        if (modules.has(id)) modules.set(id, (match[2] ?? match[3])!);
      }
      for (const module of modules.values()) {
        if (isAbsolute(module)) throw new Error(`Gradle module requires a workspace-relative path: ${module}`);
        const absolute = resolve(current, module);
        inside(root, absolute);
        if (relative(resolve(root), absolute) !== relative(canonicalPath(root), canonicalPath(absolute))) throw new Error(`Gradle module directory cannot be a source symlink: ${module}`);
        registerBuildOutput(absolute);
      }
      for (const match of text.matchAll(gradlePattern(/\bincludeBuild\s*\(?\s*(?:"([^"\\$]+)"|'([^'\\]+)')/))) {
        const included = match[1] ?? match[2];
        if (included === undefined) continue;
        if (isAbsolute(included)) throw new Error(`Included Gradle build requires a workspace-relative path: ${included}`);
        visit(resolve(current, included));
      }
    }
  }
  visit(root);
  const project = projectRoot(root, directory);
  visit(project);
  visit(join(project, 'android'));
  return outputs;
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

function validateFlutterDependencies(root: string, project = root): void {
  const manifest = join(project, 'pubspec.yaml');
  if (!existsSync(manifest)) return;
  const workspace = canonicalPath(root);
  const rootSpec = yaml(manifest);
  const overridesFile = join(project, 'pubspec_overrides.yaml');
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
    if (isAbsolute(lexical) || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(actual) || actual === '..' || actual.startsWith(`..${sep}`) || lexical !== actual || generatedInProject(lexical, 'flutter', relative(root, project)) || generatedInProject(actual, 'flutter', relative(root, project))) {
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
      pathDependency(name, overridden ? overrides[name] : dependency, overridden ? project : directory);
    }
  }


  visit(project, true);
  const lockFile = join(project, 'pubspec.lock');
  if (existsSync(lockFile)) {
    const packages = mapping(yaml(lockFile).packages, lockFile);
    for (const [name, value] of Object.entries(packages)) {
      const entry = mapping(value, lockFile);
      if (entry.source === 'path') {
        const description = mapping(entry.description, lockFile);
        pathDependency(name, { path: description.path }, project);
      } else if (entry.source === 'hosted' || entry.source === 'sdk' || entry.source === 'git') immutablePackages.add(name);
    }
  }

  const packageConfig = join(project, '.dart_tool', 'package_config.json');
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
    visit(packageRoot, canonicalPath(packageRoot) === canonicalPath(project));
  }
}

function flutterDependencyDigest(root: string): string {
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

function projectRoot(root: string, directory = '.'): string {
  if (isAbsolute(directory)) throw new Error('Project directory must be workspace-relative');
  const project = resolve(root, directory);
  if (project !== resolve(root)) inside(root, project);
  return project;
}

function generatedInProject(path: string, framework: Framework, directory = '.'): boolean {
  if (isGeneratedPath(path, framework)) return true;
  const nested = relative(directory, path);
  return nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested) && isGeneratedPath(nested, framework);
}

function sourceFiles(root: string, framework: Framework, activeDirectory: string, resolutions: string[], moduleOutputs: readonly string[]): string[] {
  const files: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute);
      const portable = path.split(sep).join('/');
      if (generatedInProject(path, framework, activeDirectory) || moduleOutputs.some(output => portable === output || portable.startsWith(`${output}/`))) {
        if (entry.isDirectory()) {
          const records = entry.name === 'node_modules' ? ['.package-lock.json', '.modules.yaml', '.pnpm/lock.yaml']
            : entry.name === 'Pods' ? ['Manifest.lock']
              : entry.name === '.build' ? ['workspace-state.json']
                : entry.name === 'build' ? ['SourcePackages/workspace-state.json', 'DerivedData/SourcePackages/workspace-state.json']
                  : entry.name === 'DerivedData' ? ['SourcePackages/workspace-state.json'] : [];
          for (const record of records) {
            const metadata = join(absolute, record);
            const stat = lstatSync(metadata, { throwIfNoEntry: false });
            if (stat && relative(canonicalPath(root), canonicalPath(metadata)) !== relative(resolve(root), metadata)) throw new Error(`Dependency resolution metadata cannot traverse a source symlink: ${metadata}`);
            if (stat?.isSymbolicLink()) throw new Error(`Dependency resolution metadata cannot be a symlink: ${metadata}`);
            if (stat) resolutions.push(join(path, record));
          }
        }
        if (entry.isFile() && entry.name === 'install-state.gz') resolutions.push(path);
        continue;
      }
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Source symlinks are not trusted dependency inputs: ${path}`);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files.push(path);
      else throw new Error(`Dependency input must be a regular source file: ${path}`);
    }
  }
  visit(root);
  return files;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid dependency metadata at ${path}`);
  return value as Record<string, unknown>;
}

function dependencyInputs(root: string, framework: Framework, activeDirectory = '.'): { files: string[]; local: Set<string>; resolutions: string[]; goFiles?: ReadonlySet<string> } {
  projectRoot(root, activeDirectory);
  const resolutions: string[] = [];
  const moduleOutputs = [...generatedModulePaths(root, framework, activeDirectory)];
  const files = sourceFiles(root, framework, activeDirectory, resolutions, moduleOutputs);
  const go = framework === 'mygo' ? goDependencyInputs(root, activeDirectory, path => generatedInProject(path, framework, activeDirectory)) : undefined;
  const javascriptActive = framework !== 'mygo' || ['package.json', 'frontend/package.json'].some(path => existsSync(join(root, activeDirectory, path)));
  const local = new Set<string>(go?.local);
  const packages = new Map<string, string>();
  for (const path of files.filter(path => javascriptActive && basename(path) === 'package.json')) {
    const pkg = object(JSON.parse(readFileSync(join(root, path), 'utf8')), path);
    if (typeof pkg.name === 'string') packages.set(pkg.name, dirname(path));
  }
  function owned(value: string, directory: string, native = false): void {
    if (!value || isAbsolute(value) || /^[a-z]:[\\/]/i.test(value)) throw new Error(`Local dependency requires a workspace-relative path: ${value}`);
    const absolute = resolve(root, directory, value);
    const path = relative(resolve(root), absolute);
    if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error(`Local dependency escapes fingerprinted workspace source: ${value}`);
    if (path) inside(root, absolute);
    const portable = path.split(sep).join('/');
    if (generatedInProject(path, framework, activeDirectory) || moduleOutputs.some(output => portable === output || portable.startsWith(`${output}/`))) {
      // Native autolinking may reference installed JS packages before installation.
      // Their resolution locks, rather than generated cache source, carry authority.
      if (native && path.split(sep).includes('node_modules')) return;
      throw new Error(`Local dependency is outside fingerprinted workspace source: ${value}`);
    }
    if (!existsSync(absolute)) {
      if (native) return; // Optional native file collections may legitimately be empty.
      throw new Error(`Local dependency does not exist: ${value}`);
    }
    const actual = relative(canonicalPath(root), canonicalPath(absolute));
    if (path !== actual || lstatSync(absolute).isSymbolicLink()) throw new Error(`Local dependency source symlinks are not trusted: ${value}`);
    local.add(path);
  }
  function reference(value: unknown, directory: string, name?: string): void {
    if (typeof value !== 'string') return;
    const match = /^(?:file|link|portal):(.*)$/.exec(value);
    if (match) owned(decodeURIComponent(match[1]!), directory);
    else if (value.startsWith('.') || isAbsolute(value) || /^[a-z]:[\\/]/i.test(value)) owned(value, directory);
    else if (value.startsWith('workspace:')) {
      const target = name ? packages.get(name) : undefined;
      if (target === undefined) throw new Error(`Workspace dependency ${name ?? value} has no owned package manifest`);
      owned(relative(resolve(root, directory), resolve(root, target)) || '.', directory);
    }
  }
  function declarations(value: unknown, directory: string): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [name, child] of Object.entries(value)) {
      if (typeof child === 'object') declarations(child, directory);
      else reference(child, directory, name);
    }
  }
  function npmResolutions(value: unknown, directory: string): void {
    if (!value || typeof value !== 'object') return;
    const entry = value as Record<string, unknown>;
    if (entry.link === true && typeof entry.resolved === 'string') owned(entry.resolved.replace(/^(?:file|link):/, ''), directory);
    for (const [key, child] of Object.entries(entry)) {
      if (key === 'resolved' || key === 'version') reference(child, directory);
      else if (child && typeof child === 'object') npmResolutions(child, directory);
    }
  }
  function pnpmResolutions(lock: Record<string, unknown>, directory: string, path: string): void {
    for (const [importer, value] of Object.entries(mapping(lock.importers, path))) {
      const base = relative(root, resolve(root, directory, importer));
      const spec = mapping(value, path);
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [dependency, value] of Object.entries(mapping(spec[field], path))) {
          if (typeof value === 'string') reference(value, base, dependency);
          else {
            const resolution = mapping(value, path);
            reference(resolution.specifier, base, dependency);
            reference(resolution.version, base, dependency);
          }
        }
      }
    }
    for (const field of ['packages', 'snapshots']) {
      for (const [key, value] of Object.entries(mapping(lock[field], path))) {
        const local = /(?:file|link|portal):([^(:]+)/.exec(key);
        if (local) owned(decodeURIComponent(local[1]!), directory);
        const record = mapping(value, path);
        reference(mapping(record.resolution, path).tarball, directory);
      }
    }
  }
  for (const path of files) {
    const name = basename(path);
    const directory = dirname(path);
    if (framework === 'mygo' && (!javascriptActive || !['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'].includes(name))) continue;
    if (name === 'package.json') {
      const pkg = object(JSON.parse(readFileSync(join(root, path), 'utf8')), path);
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides', 'resolutions']) declarations(pkg[field], directory);
    } else if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') {
      const lock = object(JSON.parse(readFileSync(join(root, path), 'utf8')), path);
      npmResolutions(lock, directory);
    } else if (name === 'pnpm-lock.yaml') {
      pnpmResolutions(yaml(join(root, path)), directory, path);
    } else if (['yarn.lock', 'bun.lock'].includes(name)) {
      const text = readFileSync(join(root, path), 'utf8');
      for (const match of text.matchAll(/(?:file|link|portal):([^\s"'`,}\]]+)/g)) owned(decodeURIComponent(match[1]!.split('::')[0]!), directory);
    } else if (name === 'Package.swift') {
      const text = manifestCode(join(root, path));
      for (const match of text.matchAll(/\.package\s*\(\s*(?:name\s*:\s*"[^"]*"\s*,\s*)?path\s*:\s*"([^"]+)"/g)) owned(match[1]!, directory);
      for (const match of text.matchAll(/\burl\s*:\s*"([^"]+)"/g)) reference(match[1]!, directory);
    } else if (name === 'Podfile' || name.endsWith('.podspec')) {
      const text = manifestCode(join(root, path), true);
      for (const match of text.matchAll(/(?::(?:path|podspec)\s*=>\s*|(?:path|podspec)\s*:\s*)["']([^"']+)["']/g)) owned(match[1]!, directory, true);
      for (const match of text.matchAll(/(?::git\s*=>\s*|git\s*:\s*)["']([^"']+)["']/g)) reference(match[1]!, directory);
    } else if (name === 'Podfile.lock') {
      const lock = yaml(join(root, path));
      for (const value of Object.values(mapping(lock['EXTERNAL SOURCES'], path))) {
        const external = mapping(value, path);
        for (const field of [':path', ':podspec']) if (typeof external[field] === 'string') owned(external[field], directory, true);
        reference(external[':git'], directory);
      }
    } else if (name === 'project.pbxproj') {
      const text = manifestCode(join(root, path));
      for (const match of text.matchAll(/\brelativePath\s*=\s*"?([^;"\r\n]+)"?\s*;/g)) owned(match[1]!.trim(), dirname(directory));
    } else if (/^(?:settings|build)\.gradle(?:\.kts)?$/.test(name)) {
      const text = gradleCode(join(root, path));
      for (const match of text.matchAll(gradlePattern(/\b(?:includeBuild\s*\(?\s*|projectDir\s*=\s*file\s*\(\s*|fileTree\s*\(\s*(?:dir\s*[:=]\s*)?)(?:"([^"\\$]+)"|'([^'\\]+)')/))) {
        const value = match[1] ?? match[2];
        if (value !== undefined) owned(value, directory, true);
      }
      // Only literal collections establish local ownership. Gradle is executable;
      // dynamic expressions cannot be proven by this static dependency check.
      const collections = gradlePattern(/\b(files|dirs)\b\s*(?:(\()|(?=["']))/);
      const literalPath = /"([^"\\$]*)"|'([^'\\]*)'/y;
      for (let match; (match = collections.exec(text));) {
        if (!match[1]) continue;
        let offset = collections.lastIndex;
        const parenthesized = Boolean(match[2]);
        const whitespace = parenthesized ? /\s/ : /[ \t]/;
        while (true) {
          while (offset < text.length && whitespace.test(text[offset]!)) offset++;
          if (parenthesized && text[offset] === ')') { offset++; break; }
          if (!parenthesized && (offset === text.length || /[\r\n;}]/.test(text[offset]!))) break;
          literalPath.lastIndex = offset;
          const literal = literalPath.exec(text);
          if (!literal) throw new Error(`Cannot prove Gradle ${match[1]} collection in ${path}: expected literal paths`);
          owned((literal[1] ?? literal[2])!, directory, true);
          offset = literalPath.lastIndex;
          while (offset < text.length && whitespace.test(text[offset]!)) offset++;
          if (text[offset] === ',') {
            offset++;
            while (offset < text.length && /\s/.test(text[offset]!)) offset++;
            continue;
          }
          if (parenthesized && text[offset] === ')') { offset++; break; }
          if (!parenthesized && (offset === text.length || /[\r\n;}]/.test(text[offset]!))) break;
          throw new Error(`Cannot prove Gradle ${match[1]} collection in ${path}: expected literal paths`);
        }
        collections.lastIndex = offset;
      }
      for (const match of text.matchAll(gradlePattern(/\burl\s*(?:=\s*)?(?:uri\s*\(?\s*)?(?:"([^"\\$]+)"|'([^'\\]+)')/))) {
        const value = match[1] ?? match[2];
        if (value === undefined) continue;
        if (/^[a-z][a-z0-9+.-]*:/i.test(value)) reference(value, directory);
        else owned(value, directory, true);
      }
    }
  }
  for (const path of resolutions) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    inside(root, absolute);
    if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error(`Dependency resolution metadata must be a regular file: ${path}`);
    if (basename(path) === '.package-lock.json') npmResolutions(object(JSON.parse(readFileSync(absolute, 'utf8')), path), dirname(dirname(path)));
    else if (path.endsWith(`${sep}.pnpm${sep}lock.yaml`)) pnpmResolutions(yaml(absolute), dirname(dirname(dirname(path))), path);
    else if (basename(path) === 'workspace-state.json') {
      const metadata = object(JSON.parse(readFileSync(absolute, 'utf8')), path);
      const state = metadata.object === undefined ? metadata : object(metadata.object, path);
      if (Array.isArray(state.dependencies)) {
        for (const value of state.dependencies) {
          const dependency = object(value, path);
          const reference = object(dependency.packageRef, path);
          if ((reference.kind === 'fileSystem' || reference.kind === 'localSourceControl') && typeof reference.location === 'string') {
            const location = isAbsolute(reference.location) ? relative(resolve(root), reference.location) : join(activeDirectory, reference.location);
            owned(location || '.', '.');
          }
        }
      }
    }
  }
  return { files, local, resolutions, ...(go ? { goFiles: go.files } : {}) };
}

/** Validate declarations before any source is granted verification authority. */
export function validateLocalDependencies(root: string, framework?: Framework, directory = '.'): void {
  if (framework === undefined || framework === 'flutter') {
    validateFlutterDependencies(root, projectRoot(root, directory));
    return;
  }
  dependencyInputs(root, framework, directory);
}

function resolutionMetadata(path: string, framework: Framework): boolean {
  const name = basename(path);
  if (framework === 'mygo') return ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', '.pnp.cjs'].includes(name);
  return ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Podfile', 'Podfile.lock', 'Package.swift', 'Package.resolved', 'Cartfile', 'Cartfile.resolved', 'project.pbxproj', 'gradle.properties', 'gradle.lockfile', 'gradle-wrapper.properties', 'verification-metadata.xml', 'libs.versions.toml', '.pnp.cjs'].includes(name)
    || /\.(?:gradle(?:\.kts)?|podspec)$/.test(name) || path.includes('dependency-locks/');
}

export function dependencyDigest(root: string, framework?: Framework, directory = '.'): string {
  // Keep the established normalized Dart resolution contract for standalone callers.
  if (framework === undefined || framework === 'flutter') return flutterDependencyDigest(projectRoot(root, directory));
  const { files, local, resolutions, goFiles } = dependencyInputs(root, framework, directory);
  const hash = createHash('sha256').update(`factory-dependency-resolution-v2\0${framework}\0`);
  function add(path: string): void {
    const content = readFileSync(join(root, path));
    hash.update(`${path.split(sep).join('/')}\0${content.length}\0`).update(content).update('\0');
  }
  const localDirectories = [...local];
  for (const path of files) {
    if (goFiles?.has(path) || resolutionMetadata(path, framework) || localDirectories.some(directory => !directory || path === directory || path.startsWith(`${directory}${sep}`))) add(path);
  }
  if (goFiles) {
    const sourcePaths = new Set(files);
    for (const path of [...goFiles].sort()) {
      if (sourcePaths.has(path)) continue;
      const absolute = inside(root, path);
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Generated frontend dependency must be a regular owned file: ${path}`);
      add(path);
    }
  }
  // Generated installation records are excluded from source proof, but changes to
  // effective resolution must still invalidate evidence.
  const installationRecords = [join(directory, '.yarn/install-state.gz'), join(directory, '.pnp.data.json')];
  if (framework === 'mygo') installationRecords.push(join(directory, 'frontend/.yarn/install-state.gz'), join(directory, 'frontend/.pnp.data.json'));
  for (const path of [...new Set([...resolutions, ...installationRecords])].sort()) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) { hash.update(`${path}\0missing\0`); continue; }
    inside(root, absolute);
    if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink()) throw new Error(`Dependency resolution metadata must be a regular file: ${path}`);
    add(path);
  }
  return hash.digest('hex');
}
