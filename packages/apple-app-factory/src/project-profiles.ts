import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { inside } from './config.js';
import { generatedModulePaths, isGeneratedPath } from './dependencies.js';
import type { Framework, Platform, Spec } from './schemas.js';

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

function directories(root: string, framework: Framework, current = '', moduleOutputs = [...generatedModulePaths(root, framework)]): string[] {
  const result = [current];
  for (const entry of readdirSync(join(root, current), { withFileTypes: true })) {
    const path = current ? `${current}/${entry.name}` : entry.name;
    if (isGeneratedPath(path, framework) || moduleOutputs.some(output => path === output || path.startsWith(`${output}/`))) continue;
    if (entry.isSymbolicLink()) throw new Error(`Project source symlinks are not trusted: ${path}`);
    if (entry.isDirectory()) result.push(...directories(root, framework, path, moduleOutputs));
  }
  return result;
}

/** The caller resolves project.directory; this function never generates or ejects a project. */
export function assertProject(root: string, spec: Spec): void {
  const fail = (manifest: string): never => { throw new Error(`${spec.framework} build completion requires ${manifest} in the project directory`); };
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
  };
  return `${context}\n${guidance[spec.framework]}\nImplement the acceptance criteria, run the configured checks and runtime evidence commands, and leave packaging to the frozen owner command profile. Never replace checks with no-ops or claim unobserved SDK/build results.`;
}

export function doctorCommands(framework: Framework, platform: Platform): Array<{ name: string; argv: string[] }> {
  const commands: Array<{ name: string; argv: string[] }> = [];
  if (framework === 'flutter') commands.push({ name: 'Flutter', argv: ['flutter', '--version'] });
  else if (framework === 'swift') commands.push({ name: 'Swift', argv: ['swift', '--version'] });
  else if (framework === 'react-native' || framework === 'expo') commands.push({ name: 'Node.js', argv: ['node', '--version'] }, { name: 'npm', argv: ['npm', '--version'] });
  if (platform === 'ios') commands.push({ name: 'Xcode', argv: ['xcodebuild', '-version'] }, { name: 'Xcode tools', argv: ['xcrun', '--version'] });
  else commands.push({ name: 'Java', argv: ['java', '-version'] }, { name: 'Android platform tools', argv: ['adb', 'version'] });
  return commands;
}
