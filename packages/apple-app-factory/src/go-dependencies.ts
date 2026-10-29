import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { parseDocument } from 'yaml';

const MYGO_INPUT_CACHES: Record<string, true> = { node_modules: true, '.mygo': true, '.git': true, '.factory-cache': true, '.yarn': true };

export interface GoReplacement {
  module: string;
  version?: string;
  target: string;
  targetVersion?: string;
}

export interface GoManifest {
  module?: string;
  requires: ReadonlyMap<string, string>;
  tools: readonly string[];
  uses: readonly string[];
  replacements: readonly GoReplacement[];
}

interface Token { value: string; punctuation?: boolean }

/** Static go.mod/go.work grammar only: never evaluates Go or consults the Go environment. */
export function parseGoManifest(text: string, path = 'go.mod'): GoManifest {
  const tokens: Token[] = [];
  const fail = (reason: string): never => { throw new Error(`Cannot prove Go manifest ${path}: ${reason}`); };
  const escapeCharacters: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"' };
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let offset = 0;
  while (offset < text.length) {
    const character = text[offset]!;
    if (character === '\n') { tokens.push({ value: '\n', punctuation: true }); offset++; continue; }
    if (/\s/.test(character)) { offset++; continue; }
    if (text.startsWith('//', offset)) {
      while (offset < text.length && text[offset] !== '\n') offset++;
      continue;
    }
    if (text.startsWith('/*', offset)) {
      const end = text.indexOf('*/', offset + 2);
      if (end < 0) fail('unterminated comment');
      for (const line of text.slice(offset, end + 2).matchAll(/\n/g)) tokens.push({ value: line[0], punctuation: true });
      offset = end + 2;
      continue;
    }
    if (character === '(' || character === ')') {
      tokens.push({ value: character, punctuation: true }); offset++; continue;
    }
    if (character === '"' || character === '`') {
      const quote = character;
      offset++;
      let value = '', closed = false;
      const bytes: number[] = [];
      function flushBytes(): void {
        if (!bytes.length) return;
        try { value += utf8.decode(Uint8Array.from(bytes)); }
        catch { fail('non-UTF-8 path escape is unsupported'); }
        bytes.length = 0;
      }
      while (offset < text.length) {
        const next = text[offset++]!;
        if (next === quote) { closed = true; break; }
        if (next === '\n' || next === '\r') fail('newline in quoted token');
        if (next !== '\\' || quote === '`') { flushBytes(); value += next; continue; }
        const escape = text[offset++] ?? fail('unterminated escape');
        if (Object.hasOwn(escapeCharacters, escape)) { flushBytes(); value += escapeCharacters[escape]; continue; }
        const count = escape === 'x' ? 2 : escape === 'u' ? 4 : escape === 'U' ? 8 : /[0-7]/.test(escape) ? 3 : 0;
        if (!count) fail('unsupported string escape');
        const octal = /[0-7]/.test(escape);
        const digits = octal ? escape + text.slice(offset, offset + 2) : text.slice(offset, offset + count);
        if (digits.length !== count || !(octal ? /^[0-7]+$/ : /^[\da-f]+$/i).test(digits)) fail('invalid string escape');
        offset += octal ? 2 : count;
        const code = Number.parseInt(digits, octal ? 8 : 16);
        if (code > (octal || escape === 'x' ? 255 : 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) fail('invalid string code point');
        if (octal || escape === 'x') bytes.push(code);
        else { flushBytes(); value += String.fromCodePoint(code); }
      }
      if (!closed) fail('unterminated quoted token');
      flushBytes();
      tokens.push({ value });
      continue;
    }
    const start = offset;
    while (offset < text.length && !/[\s()"`]/.test(text[offset]!) && !text.startsWith('//', offset) && !text.startsWith('/*', offset)) offset++;
    if (offset === start) fail('invalid token');
    const value = text.slice(start, offset);
    tokens.push({ value, ...(value === '=>' ? { punctuation: true } : {}) });
  }
  const requires = new Map<string, string>();
  const tools: string[] = [], uses: string[] = [], replacements: GoReplacement[] = [];
  let module: string | undefined;
  const supported: Record<string, true> = { module: true, go: true, toolchain: true, godebug: true, require: true, exclude: true, replace: true, retract: true, tool: true, use: true, ignore: true };
  const punctuation = (index: number, value: string) => tokens[index]?.punctuation && tokens[index]?.value === value;
  function row(directive: string, values: Token[]): void {
    if (!values.length) fail(`empty ${directive} directive`);
    if (directive === 'replace') {
      const arrow = values.findIndex(token => token.punctuation && token.value === '=>');
      const before = values.slice(0, arrow), after = values.slice(arrow + 1);
      if (arrow < 0 || before.length < 1 || before.length > 2 || after.length < 1 || after.length > 2 || [...before, ...after].some(token => token.punctuation)) fail('invalid replace directive');
      replacements.push({ module: before[0]!.value, ...(before[1] ? { version: before[1].value } : {}), target: after[0]!.value, ...(after[1] ? { targetVersion: after[1].value } : {}) });
    } else {
      if (values.some(token => token.punctuation)) fail(`invalid ${directive} directive`);
      if (directive === 'module') {
        if (values.length !== 1 || module !== undefined) fail('invalid module declaration');
        module = values[0]!.value;
      } else if (directive === 'require') {
        if (values.length !== 2) fail('invalid require directive');
        requires.set(values[0]!.value, values[1]!.value);
      } else if (directive === 'use' || directive === 'tool') {
        if (values.length !== 1) fail(`invalid ${directive} directive`);
        (directive === 'use' ? uses : tools).push(values[0]!.value);
      }
    }
  }
  let index = 0;
  while (index < tokens.length) {
    if (punctuation(index, '\n')) { index++; continue; }
    const directive = tokens[index++]!;
    if (directive.punctuation || !Object.hasOwn(supported, directive.value)) fail(`unsupported directive ${directive.value}`);
    if (punctuation(index, '(')) {
      index++;
      while (index < tokens.length && !punctuation(index, ')')) {
        if (punctuation(index, '\n')) { index++; continue; }
        const values: Token[] = [];
        while (index < tokens.length && !punctuation(index, '\n') && !punctuation(index, ')')) values.push(tokens[index++]!);
        row(directive.value, values);
      }
      if (!punctuation(index, ')')) fail('unterminated directive block');
      index++;
      if (index < tokens.length && !punctuation(index, '\n')) fail('unexpected token after block');
    } else {
      const values: Token[] = [];
      while (index < tokens.length && !punctuation(index, '\n')) values.push(tokens[index++]!);
      row(directive.value, values);
    }
  }
  return { ...(module === undefined ? {} : { module }), requires, tools, uses, replacements };
}

function ownedPath(root: string, value: string, base = root, allowMissing = false): string {
  if (!value || value.includes('\0') || /[\r\n]/.test(value) || isAbsolute(value) || win32.isAbsolute(value) || /^[a-z]:/i.test(value)) throw new Error(`Go local dependency requires a workspace-relative path: ${value}`);
  const absolute = resolve(base, value), child = relative(resolve(root), absolute);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error(`Go local dependency escapes fingerprinted workspace source: ${value}`);
  let current = resolve(root);
  for (const part of ['', ...child.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat && allowMissing) break;
    if (!stat) throw new Error(`Go local dependency does not exist: ${current}`);
    if (stat.isSymbolicLink()) throw new Error(`Go dependency source symlinks are not trusted: ${current}`);
  }
  return absolute;
}

function regularFile(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`Go manifest must be a regular owned source file: ${path}`);
}

/** Absolute closest owned workspace path; callers MUST set GOWORK to this or 'off'. */
export function closestOwnedGoWorkspace(root: string, directory = '.'): string | undefined {
  let current = ownedPath(root, directory);
  if (!lstatSync(current).isDirectory()) throw new Error('Go project directory must be a regular owned directory');
  while (true) {
    const work = join(current, 'go.work');
    if (lstatSync(work, { throwIfNoEntry: false })) { regularFile(work); return work; }
    if (current === resolve(root)) return undefined;
    current = dirname(current);
  }
}

export interface GoDependencyInputs {
  files: ReadonlySet<string>;
  local: ReadonlySet<string>;
}

/** JSON is static; TS configuration remains trusted executable code, not inferred paths. */
function myGoConfigInputs(root: string, project: string, generated: (path: string) => boolean, files: Set<string>, local: Set<string>): void {
  const config = join(project, 'mygo.json');
  if (!lstatSync(config, { throwIfNoEntry: false })) return;
  regularFile(config);
  const portable = (path: string) => relative(resolve(root), path);
  files.add(portable(config));
  // encoding/json matches Go field names case-insensitively. Do not let aliases
  // evade the ownership check, or ambiguous duplicates choose a different input.
  function record(value: unknown, field: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`MyGo ${field} must be a JSON object`);
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/ſ/g, 's');
      if (Object.hasOwn(result, normalized)) throw new Error(`MyGo ${field} has duplicate field ${key}`);
      result[normalized] = child;
    }
    return result;
  }
  const text = readFileSync(config, 'utf8');
  const value: unknown = JSON.parse(text);
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error(`MyGo JSON fields must be unambiguous: ${document.errors.map(error => error.message).join('; ')}`);
  const spec = record(value, 'mygo.json');
  function input(value: unknown, field: string, kind: 'file' | 'directory' | 'source' | 'resource' | 'write'): void {
    if (typeof value !== 'string' || !value || value.startsWith('~/')) throw new Error(`MyGo ${field} requires a nonempty workspace-relative path`);
    const absolute = ownedPath(root, value, project, kind === 'write' || field === 'frontendDist');
    const path = portable(absolute);
    const projectPath = relative(project, absolute);
    if (field === 'frontendDist' && projectPath.split(sep).some(part => Object.hasOwn(MYGO_INPUT_CACHES, part))) throw new Error(`MyGo frontendDist cannot embed dependency or development caches: ${value}`);
    const generatedFrontend = field === 'frontendDist' && (projectPath === 'dist' || projectPath.startsWith(`dist${sep}`) || projectPath.startsWith(`build${sep}`)) && !/^build[\\/]darwin-(?:arm64|amd64|universal)(?:[\\/]|$)/.test(projectPath);
    if (generated(path) && !generatedFrontend) throw new Error(`MyGo ${field} is outside fingerprinted workspace source: ${value}`);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (generatedFrontend && !stat) return; // Import snapshots rebuild this output before verification.
    if ((kind === 'file' && !stat?.isFile()) || (kind === 'directory' && !stat?.isDirectory()) || ((kind === 'source' || kind === 'resource') && !stat?.isFile() && !stat?.isDirectory()) || (kind === 'write' && stat && !stat.isFile())) throw new Error(`MyGo ${field} requires a regular owned ${kind === 'directory' ? 'directory' : 'file or directory'}: ${value}`);
    // Resource and frontend trees are copied/embedded whole by MyGo, unlike
    // source traversal: even an excluded child would otherwise reach the app.
    function tree(current: string): void {
      const child = portable(current), info = lstatSync(current);
      if ((!generatedFrontend && generated(child)) || relative(absolute, current).split(sep).some(part => Object.hasOwn(MYGO_INPUT_CACHES, part))) throw new Error(`MyGo ${field} includes excluded mutable input: ${child}`);
      if (info.isSymbolicLink()) throw new Error(`MyGo ${field} source symlinks are not trusted: ${child}`);
      if (info.isDirectory()) {
        for (const entry of readdirSync(current).sort()) tree(join(current, entry));
      } else if (!info.isFile()) throw new Error(`MyGo ${field} requires regular owned source: ${child}`);
      else if (generatedFrontend) files.add(child);
    }
    if (kind === 'resource' || field === 'frontendDist') tree(absolute);
    local.add(path);
  }
  function optional(spec: Record<string, unknown>, key: string, field: string, kind: 'file' | 'directory' | 'source' | 'resource' | 'write' = 'file'): void {
    if (Object.hasOwn(spec, key)) input(spec[key], field, kind);
  }
  input(Object.hasOwn(spec, 'main') ? spec.main : '.', 'main', 'source');
  optional(spec, 'icon', 'icon');
  optional(spec, 'frontenddist', 'frontendDist', 'directory');
  if (Object.hasOwn(spec, 'resources')) {
    if (!Array.isArray(spec.resources)) throw new Error('MyGo resources must be an array of owned paths');
    for (const value of spec.resources) input(value, 'resources', 'resource');
  }
  // The resources directory (including platform resources and default icon)
  // ships implicitly even when no resources field appears in the JSON.
  if (lstatSync(join(project, 'resources'), { throwIfNoEntry: false })) input('resources', 'resources', 'resource');
  if (Object.hasOwn(spec, 'bindings')) input(spec.bindings, 'bindings', 'write');
  else if (lstatSync(join(project, 'frontend'), { throwIfNoEntry: false })?.isDirectory()) input('frontend/src/mygo.ts', 'bindings', 'write');
  else if (lstatSync(join(project, 'package.json'), { throwIfNoEntry: false })) input('src/mygo.ts', 'bindings', 'write');
  else if (['devurl', 'devcommand', 'buildcommand', 'frontenddist'].some(key => spec[key])) input('mygo.ts', 'bindings', 'write');
  if (spec.macos !== undefined && spec.macos !== null) {
    const macos = record(spec.macos, 'macos');
    optional(macos, 'icon', 'macos.icon');
    optional(macos, 'entitlements', 'macos.entitlements');
    if (macos.helperentitlements !== undefined && macos.helperentitlements !== null) {
      // Helper keys name paths inside the assembled resources, not project files.
      if (typeof macos.helperentitlements !== 'object' || Array.isArray(macos.helperentitlements)) throw new Error('MyGo macos.helperEntitlements must be an object');
      for (const [helper, value] of Object.entries(macos.helperentitlements as Record<string, unknown>)) {
        if (!helper || helper.includes('\0') || /[\r\n\\]/.test(helper) || isAbsolute(helper) || win32.isAbsolute(helper) || /^[a-z]:/i.test(helper) || helper.split('/').includes('..')) throw new Error(`MyGo helperEntitlements helper must stay inside bundle resources: ${helper}`);
        input(value, 'macos.helperEntitlements', 'file');
      }
    }
  }
  if (spec.updates !== undefined && spec.updates !== null) {
    const updates = record(spec.updates, 'updates');
    optional(updates, 'privatekey', 'updates.privateKey');
    optional(updates, 'changelog', 'updates.changelog');
    if (!Object.hasOwn(updates, 'changelog') && lstatSync(join(project, 'CHANGELOG.md'), { throwIfNoEntry: false })) input('CHANGELOG.md', 'updates.changelog', 'file');
  }
  if (spec.windows !== undefined && spec.windows !== null) optional(record(spec.windows, 'windows'), 'certificate', 'windows.certificate');
}

/** Only the selected module, its owned workspace and local replacement closure are active. */
export function goDependencyInputs(root: string, directory: string, generated: (path: string) => boolean): GoDependencyInputs {
  const files = new Set<string>(), local = new Set<string>(), visited = new Set<string>();
  const project = ownedPath(root, directory);
  const portable = (path: string) => relative(resolve(root), path);
  if (generated(portable(project))) throw new Error('Go project is outside fingerprinted workspace source');
  function source(value: string, base: string): string {
    const absolute = ownedPath(root, value, base);
    if (generated(portable(absolute))) throw new Error(`Go local dependency is outside fingerprinted workspace source: ${value}`);
    if (!lstatSync(absolute).isDirectory()) throw new Error(`Go local dependency must identify a regular source directory: ${value}`);
    local.add(portable(absolute));
    return absolute;
  }
  function manifest(path: string): GoManifest {
    regularFile(path);
    files.add(portable(path));
    const sum = path === join(dirname(path), 'go.work') ? `${path}.sum` : join(dirname(path), 'go.sum');
    if (lstatSync(sum, { throwIfNoEntry: false })) { regularFile(sum); files.add(portable(sum)); }
    return parseGoManifest(readFileSync(path, 'utf8'), portable(path));
  }
  function replacements(parsed: GoManifest, base: string): void {
    for (const replacement of parsed.replacements) {
      if (replacement.targetVersion !== undefined) {
        // A versioned RHS is remote only when it is a module path, never a local path.
        if (!/^v\d/.test(replacement.targetVersion) || !replacement.target || /[\s\\:]/.test(replacement.target) || replacement.target.split('/').some(part => !part || part === '.' || part === '..') || isAbsolute(replacement.target) || win32.isAbsolute(replacement.target)) throw new Error(`Invalid versioned Go replacement: ${replacement.target}`);
        continue;
      }
      const target = source(replacement.target, base);
      visit(target);
    }
  }
  function visit(moduleRoot: string): void {
    if (visited.has(moduleRoot)) return;
    visited.add(moduleRoot);
    const parsed = manifest(join(moduleRoot, 'go.mod'));
    if (!parsed.module || parsed.uses.length) throw new Error(`Invalid Go module declaration: ${moduleRoot}`);
    const vendor = join(moduleRoot, 'vendor', 'modules.txt');
    if (lstatSync(vendor, { throwIfNoEntry: false })) { regularFile(vendor); files.add(portable(vendor)); local.add(portable(join(moduleRoot, 'vendor'))); }
    replacements(parsed, moduleRoot);
  }
  visit(project);
  const workspace = closestOwnedGoWorkspace(root, directory);
  if (workspace) {
    if (generated(portable(workspace))) throw new Error('Go workspace is outside fingerprinted workspace source');
    const parsed = manifest(workspace);
    if (parsed.module || parsed.requires.size || parsed.tools.length) throw new Error(`Invalid Go workspace declaration: ${workspace}`);
    const modules = parsed.uses.map(value => source(value, dirname(workspace)));
    if (!modules.includes(project)) throw new Error('Closest owned go.work must include the selected Go module');
    for (const moduleRoot of modules) visit(moduleRoot);
    replacements(parsed, dirname(workspace));
  }
  myGoConfigInputs(root, project, generated, files, local);
  return { files, local };
}
