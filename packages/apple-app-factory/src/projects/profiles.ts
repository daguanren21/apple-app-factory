import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { inside } from '../configuration/config.js';
import { generatedModulePaths, isGeneratedPath } from './dependencies.js';
import { parseGoManifest } from './go-dependencies.js';
import type { Framework, Platform, Spec } from '../contracts/schemas.js';

function file(root: string, path: string): string | undefined {
  const absolute = inside(root, path);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Project manifest must be a regular source file: ${path}`);
  return readFileSync(absolute, 'utf8');
}

function json(root: string, path: string, comments = false): Record<string, unknown> | undefined {
  let text = file(root, path);
  if (text === undefined) return undefined;
  if (comments) text = text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, token => token.startsWith('/') ? '' : token);
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected a project manifest object: ${path}`);
  return value as Record<string, unknown>;
}

const projectIndicators: Readonly<Record<string, true>> = {
  'package.json': true, 'pubspec.yaml': true, 'pubspec_overrides.yaml': true, 'go.mod': true, 'go.work': true, 'Package.swift': true,
  'settings.gradle': true, 'settings.gradle.kts': true, 'build.gradle': true, 'build.gradle.kts': true, Podfile: true,
  'mygo.json': true, 'mygo.config.ts': true, 'manifest.json': true, 'pages.json': true, 'app.json': true,
  'Cargo.toml': true, 'pyproject.toml': true, 'composer.json': true,
};
const sourceContainers: Readonly<Record<string, true>> = { src: true, Sources: true, lib: true, apps: true, packages: true, native: true, ios: true, android: true };

/** Existing-but-unidentified source must not silently acquire a new framework. */
export function hasProjectIndicators(root: string): boolean {
  const info = lstatSync(root, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) return true;
  return readdirSync(root, { withFileTypes: true, encoding: 'utf8' }).some(entry => projectIndicators[entry.name] === true
    || /\.(?:xcodeproj|xcworkspace|sln|csproj|fsproj|vcxproj)$/.test(entry.name)
    || entry.isDirectory() && sourceContainers[entry.name] === true
    || entry.isFile() && /\.(?:swift|m|mm|dart|java|kt|go|js|jsx|ts|tsx|vue|cs|py|rs)$/.test(entry.name));
}

/** Detect an existing stack from bounded, local manifests without probing executables or scanning arbitrary descendants. */
export function detectProjectFramework(root: string): Framework | undefined {
  const rootInfo = lstatSync(root, { throwIfNoEntry: false });
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return undefined;
  try {
    const matches: Framework[] = [];
    const pkg = json(root, 'package.json');
    const dependencies = pkg ? {
      ...(pkg.dependencies as Record<string, unknown> | undefined),
      ...(pkg.devDependencies as Record<string, unknown> | undefined),
    } : {};
    const hasExpo = typeof dependencies.expo === 'string' && dependencies.expo.length > 0;
    const hasReactNative = typeof dependencies['react-native'] === 'string' && dependencies['react-native'].length > 0;
    if (hasExpo) matches.push('expo');
    else if (hasReactNative) matches.push('react-native');

    const manifestPath = json(root, 'src/manifest.json', true) ? 'src/' : '';
    const manifest = json(root, `${manifestPath}manifest.json`, true);
    const pages = json(root, `${manifestPath}pages.json`, true);
    const uniCli = typeof dependencies['@dcloudio/uni-app'] === 'string' && !!dependencies['@dcloudio/uni-app'];
    const uniClassic = file(root, `${manifestPath}App.vue`) !== undefined && (file(root, `${manifestPath}main.js`) !== undefined || file(root, `${manifestPath}main.ts`) !== undefined);
    if (manifest && Array.isArray(pages?.pages) && pages.pages.length > 0 && (uniCli || uniClassic)) matches.push('uni-app');

    const pubspec = file(root, 'pubspec.yaml');
    if (pubspec) {
      const document = parseDocument(pubspec);
      if (document.errors.length) return undefined;
      const value = document.toJS() as unknown;
      const dependenciesValue = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).dependencies : undefined;
      const flutter = dependenciesValue && typeof dependenciesValue === 'object' && !Array.isArray(dependenciesValue) ? (dependenciesValue as Record<string, unknown>).flutter : undefined;
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).name === 'string'
        && flutter && typeof flutter === 'object' && !Array.isArray(flutter) && (flutter as Record<string, unknown>).sdk === 'flutter') matches.push('flutter');
    }

    const goManifest = file(root, 'go.mod');
    const nativeConfig = file(root, 'mygo.json');
    const webConfig = file(root, 'mygo.config.ts');
    if (goManifest || nativeConfig || webConfig) {
      const isMygoModule = goManifest !== undefined && parseGoManifest(goManifest).requires.has('github.com/egoist/mygo');
      const exactlyOneConfig = (nativeConfig === undefined) !== (webConfig === undefined);
      let validMygo = isMygoModule && exactlyOneConfig;
      if (validMygo && nativeConfig !== undefined) validMygo = json(root, 'mygo.json') !== undefined;
      if (validMygo && webConfig !== undefined) validMygo = json(root, 'package.json') !== undefined || json(root, 'frontend/package.json') !== undefined;
      if (validMygo) matches.push('mygo');
      else if (goManifest || nativeConfig || webConfig) return undefined;
    }

    const swiftPackage = file(root, 'Package.swift');
    let swift = !!swiftPackage && /swift-tools-version\s*:/.test(swiftPackage) && /\bPackage\s*\(/.test(swiftPackage);
    if (!swift) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.name.endsWith('.xcodeproj') || !entry.isDirectory()) continue;
        const project = file(root, `${entry.name}/project.pbxproj`);
        if (project && /\bPBXProject\b/.test(project)) { swift = true; break; }
      }
    }
    if (swift) matches.push('swift');

    const settings = file(root, 'settings.gradle') ?? file(root, 'settings.gradle.kts');
    if (settings) {
      const modules = new Set<string>(['']);
      const code = settings.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, ' ');
      for (const statement of code.matchAll(/\binclude\s*(?:\(\s*)?((?:['"]:[^'"]+['"]\s*,?\s*)+)/g)) {
        for (const value of statement[1]!.matchAll(/['"](:[^'"]+)['"]/g)) modules.add(value[1]!.slice(1).split(':').join('/'));
      }
      const application = [...modules].some(directory => {
        const prefix = directory ? `${directory}/` : '';
        const build = file(root, `${prefix}build.gradle`) ?? file(root, `${prefix}build.gradle.kts`);
        const manifest = file(root, `${prefix}src/main/AndroidManifest.xml`);
        return build !== undefined && !!manifest && /<manifest\b/.test(manifest) && /<application\b/.test(manifest) && /<\/manifest\s*>/.test(manifest);
      });
      if (application) matches.push('android-java');
    }

    if (matches.includes('expo') && matches.includes('react-native')) return 'expo';
    return matches.length === 1 ? matches[0] : undefined;
  } catch {
    return undefined;
  }
}

function directories(root: string, framework: Framework, current = '', moduleOutputs = [...generatedModulePaths(root, framework)]): string[] {
  const result = [current];
  for (const entry of readdirSync(join(root, current), { withFileTypes: true })) {
    const path = current ? `${current}/${entry.name}` : entry.name;
    if (isGeneratedPath(path, framework) || moduleOutputs.some(output => path === output || path.startsWith(`${output}/`))) continue;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw new Error(`Project source symlinks are not trusted: ${path}`);
    if (stat.isDirectory()) result.push(...directories(root, framework, path, moduleOutputs));
  }
  return result;
}

/** The caller resolves project.directory; this function never generates or ejects a project. */
export function assertProject(root: string, spec: Spec): void {
  const fail = (manifest: string): never => { throw new Error(`${spec.framework} build completion requires ${manifest} in the project directory`); };
  if (spec.platform === 'macos' && spec.framework !== 'mygo') fail('an existing supported iOS or Android platform; macOS is supported only for MyGo');
  if (spec.framework === 'mygo') {
    if (spec.platform !== 'macos') fail('the macOS platform');
    const mod = file(root, 'go.mod');
    if (mod === undefined || !parseGoManifest(mod).requires.has('github.com/egoist/mygo')) fail('a go.mod requiring github.com/egoist/mygo');
    const native = json(root, 'mygo.json');
    const web = file(root, 'mygo.config.ts');
    if ((native === undefined) === (web === undefined)) fail('exactly one mygo.json or mygo.config.ts');
    if (web !== undefined && !json(root, 'package.json') && !json(root, 'frontend/package.json')) fail('the original package.json or frontend/package.json for mygo.config.ts');
    return;
  }
  if (spec.framework === 'flutter') {
    const text = file(root, 'pubspec.yaml');
    if (!text) fail('a Flutter pubspec.yaml');
    const document = parseDocument(text!);
    if (document.errors.length) throw new Error(`Invalid pubspec.yaml: ${document.errors.map(error => error.message).join('; ')}`);
    const value = document.toJS();
    if (!value || typeof value.name !== 'string' || value.dependencies?.flutter?.sdk !== 'flutter') fail('a named pubspec.yaml with dependencies.flutter.sdk: flutter');
    return;
  }
  if (spec.framework === 'android-java') {
    if (spec.platform !== 'android') fail('the Android platform');
    const settings = file(root, 'settings.gradle') ?? file(root, 'settings.gradle.kts');
    const application = directories(root, spec.framework).some(directory => {
      const prefix = directory ? `${directory}/` : '';
      const build = file(root, `${prefix}build.gradle`) ?? file(root, `${prefix}build.gradle.kts`);
      if (build === undefined) return false;
      const manifest = file(root, `${prefix}src/main/AndroidManifest.xml`)?.replace(/<!--[\s\S]*?-->/g, '');
      return !!manifest && /<manifest\b/.test(manifest) && /<application\b/.test(manifest) && /<\/manifest\s*>/.test(manifest);
    });
    if (settings === undefined || !application) fail('Gradle settings/build files and an application module src/main/AndroidManifest.xml');
    return;
  }
  if (spec.framework === 'swift') {
    if (spec.platform !== 'ios') fail('the iOS platform');
    const swift = file(root, 'Package.swift');
    if (swift && /swift-tools-version\s*:/.test(swift) && /\bPackage\s*\(/.test(swift)) return;
    for (const directory of directories(root, spec.framework)) {
      if (directory.endsWith('.xcodeproj')) {
        const project = file(root, `${directory}/project.pbxproj`);
        if (project && /\bPBXProject\b/.test(project)) return;
      }
    }
    fail('a Swift Package.swift or an Xcode .xcodeproj/project.pbxproj');
  }
  const pkg = json(root, 'package.json');
  const dependencies = { ...(pkg?.dependencies as Record<string, unknown> | undefined), ...(pkg?.devDependencies as Record<string, unknown> | undefined) };
  if (spec.framework === 'uni-app') {
    const source = json(root, 'src/manifest.json', true) ? 'src/' : '';
    const manifest = json(root, `${source}manifest.json`, true);
    const pages = json(root, `${source}pages.json`, true);
    if (!manifest || !Array.isArray(pages?.pages) || !pages.pages.length) fail('manifest.json and nonempty pages.json at the root or under src/');
    const cli = typeof dependencies['@dcloudio/uni-app'] === 'string' && !!dependencies['@dcloudio/uni-app'];
    const classic = !!file(root, `${source}App.vue`) && !!(file(root, `${source}main.js`) ?? file(root, `${source}main.ts`));
    if (!cli && !classic) fail('a uni-app CLI package.json or HBuilderX App.vue and main.js/main.ts');
    return;
  }
  const required = spec.framework === 'react-native' ? 'react-native' : 'expo';
  if (!pkg || typeof dependencies[required] !== 'string' || !dependencies[required]) fail(`package.json declaring ${required}`);
}

export function buildInstructions(spec: Spec): string {
  const context = `Build the ${spec.platform} application using the ${spec.framework} stack. ${spec.project?.sourceDir ? 'Preserve the imported project and its existing native structure.' : 'Preserve any existing project, including a prepared predecessor; generate a real runnable project only when none exists in the designated project directory.'}`;
  const guidance: Record<Framework, string> = {
    flutter: 'Use a Flutter pubspec.yaml, Dart sources and the selected platform runner. Resolve dependencies with flutter pub get; keep pubspec.lock. Do not modify the Flutter SDK.',
    'android-java': 'Use a Java Android application with Gradle settings/build files and AndroidManifest.xml. Keep the Gradle wrapper and dependency locks; use the existing application module rather than rewriting it.',
    swift: 'Use the existing Xcode project or Swift package, Swift sources and iOS application configuration. Keep Package.resolved and Podfile.lock when used. Do not replace an existing Xcode project with a package.',
    'react-native': 'Use package.json with react-native and the existing iOS/Android native projects. Keep the package-manager lockfile and native dependency locks. Do not migrate to Expo or regenerate native projects.',
    expo: 'Use package.json with expo and the existing Expo application configuration. Preserve managed or prebuilt structure; do not force expo prebuild or eject. Cloud builds require the owner-configured permission and packaging commands.',
    'uni-app': 'Preserve either the existing CLI package.json with @dcloudio/uni-app or the classic HBuilderX App.vue/main.js/main.ts project without requiring npm. Keep manifest.json/pages.json (root or src) and existing native structure; use the owner-configured HBuilderX/CLI Android/iOS packager, not a fabricated artifact.',
    mygo: 'Preserve native-UI Go-only projects with go.mod and mygo.json, or existing web projects with go.mod, mygo.config.ts and their original package.json (at the root or under frontend/) and package manager; keep exactly one MyGo config and require github.com/egoist/mygo in go.mod. Native projects need neither package.json nor Bun nor Xcode. Do not rewrite a web project or require Bun solely because its config is TypeScript; preserve its existing runtime and frontend scripts. Preserve the pinned MyGo tool/module version in go.mod; do not use @latest or install tools automatically. Prepare go.sum, any go.work/go.work.sum, frontend dependency locks and generated frontend bindings before proof, preserving the original frontend build process. Use Go vet/tests plus an owner-implemented real macOS desktop acceptance harness that launches and drives the actual app; go test or a headless view test alone is not desktop acceptance, and no iOS simulator is involved. Never generate a stub acceptance command. Packaging stays local-only through the frozen direct go tool mygo build command (or owner-configured pinned direct MyGo invocation), with -sign - and -skip-notarize; never upload, notarize or access signing keychains. Use the frozen output path, architecture and app/dmg target; do not replace the owner packaging profile.',
  };
  const designSettlement = 'Design settlement — settle the architecture before writing product code. Produce at least two competing design sketches; each sketch leads with caller usage, then types/signatures, then a module map. A decision-maker context (the host native subagent) picks one as the baseline, grafts the best parts of the other sketches onto it, and records the choice and rationale in the decision log via apphx decide. Plan through code: any open question must be answered by a minimal prototype that compiles or runs, never by prose. Write docs/architecture.md last and base it only on code that has been tested. Before finalizing, screen every sketch against the bundled skills/apphx/references/design-red-flags.md; any hit means revise or reject that sketch — do not implement it and do not patch around it. If the same workaround recurs in unrelated places, or a type only compiles through any/casts, the design is wrong: redesign instead of patching. docs/architecture.md must include the module map with dependency direction, every state machine (states, transitions, events), and the owner of each module.';
  return `${context}\n${guidance[spec.framework]}\nImplement the acceptance criteria, run the configured checks and runtime evidence commands, and leave packaging to the frozen owner command profile. Never replace checks with no-ops or claim unobserved SDK/build results.\n${designSettlement}`;
}

export function doctorCommands(framework: Framework, platform: Platform): Array<{ name: string; argv: string[] }> {
  const commands: Array<{ name: string; argv: string[] }> = [];
  if (framework === 'mygo') {
    if (platform !== 'macos') throw new Error('MyGo doctor supports only macOS');
    return [
      { name: 'Go', argv: ['go', 'version'] },
      { name: 'macOS code signing', argv: ['/usr/bin/which', 'codesign'] },
      { name: 'macOS disk images', argv: ['hdiutil', 'help'] },
    ];
  }
  if (platform === 'macos') throw new Error('macOS doctor supports only MyGo');
  if (framework === 'flutter') commands.push({ name: 'Flutter', argv: ['flutter', '--version'] });
  else if (framework === 'swift') commands.push({ name: 'Swift', argv: ['swift', '--version'] });
  else if (framework === 'react-native' || framework === 'expo') commands.push({ name: 'Node.js', argv: ['node', '--version'] }, { name: 'npm', argv: ['npm', '--version'] });
  if (platform === 'ios') commands.push({ name: 'Xcode', argv: ['xcodebuild', '-version'] }, { name: 'Xcode tools', argv: ['xcrun', '--version'] });
  else commands.push({ name: 'Java', argv: ['java', '-version'] }, { name: 'Android platform tools', argv: ['adb', 'version'] });
  return commands;
}
