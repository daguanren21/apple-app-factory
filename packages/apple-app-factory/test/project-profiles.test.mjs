import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertProject, buildInstructions, doctorCommands } from '../dist/project-profiles.js';
import { dependencyDigest, generatedModulePaths, isGeneratedPath, validateLocalDependencies } from '../dist/dependencies.js';
import { sourceDigest } from '../dist/workspace.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'apphx-profiles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function file(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
}
function spec(framework, platform = framework === 'mygo' ? 'macos' : framework === 'android-java' ? 'android' : 'ios') {
  return { id: 'profiles', name: 'Profiles', purpose: 'Exercise real project boundaries', audience: 'Owners', differentiators: ['Native stack ownership'], acceptance: ['Keep project structure'], framework, platform, channel: 'local', version: '1.0.0' };
}
const manifests = {
  flutter: { 'pubspec.yaml': 'name: app\ndependencies:\n  flutter: {sdk: flutter}\n' },
  'android-java': { 'settings.gradle': "include ':mobile'\n", 'mobile/build.gradle': "plugins { id 'com.android.application' }\n", 'mobile/src/main/AndroidManifest.xml': '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="App" /></manifest>' },
  swift: { 'Package.swift': '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "App")\n' },
  'react-native': { 'package.json': { name: 'app', dependencies: { 'react-native': '0.80.0' } } },
  expo: { 'package.json': { name: 'app', dependencies: { expo: '^53.0.0' } } },
  'uni-app': { 'package.json': { name: 'app', dependencies: { '@dcloudio/uni-app': '3.0.0' } }, 'src/manifest.json': '{\n // owner configuration\n "name": "App", "description": "https://example.com"\n}', 'src/pages.json': { pages: [{ path: 'pages/index/index' }] } },
  mygo: { 'go.mod': 'module example.com/app\n\ngo 1.27.1\n\nrequire github.com/egoist/mygo v0.3.0\n', 'mygo.json': { name: 'MyGo App' } },
};
for (const [framework, files] of Object.entries(manifests)) {
  test(`${framework} requires and accepts its actual project manifests`, t => {
    const root = fixture(t);
    assert.throws(() => assertProject(root, spec(framework)), /requires/);
    for (const [path, content] of Object.entries(files)) file(root, path, content);
    assert.doesNotThrow(() => assertProject(root, spec(framework)));
    assert.match(buildInstructions(spec(framework)), new RegExp(framework));
    assert.match(buildInstructions({ ...spec(framework), project: { sourceDir: '/owner/project', directory: '.' } }), /Preserve the imported project/);
  });
}

test('Swift accepts an existing nested Xcode project without rewriting it', t => {
  const root = fixture(t);
  file(root, 'ios/App.xcodeproj/project.pbxproj', '// !$*UTF8*$!\n{ objects = { app = { isa = PBXProject; }; }; }');
  assert.doesNotThrow(() => assertProject(root, spec('swift')));
});

test('project gates reject malformed, unrelated and symlinked manifests', t => {
  const root = fixture(t);
  file(root, 'package.json', { name: 'web-only', dependencies: { react: '^19.0.0' } });
  for (const framework of ['react-native', 'expo', 'uni-app']) assert.throws(() => assertProject(root, spec(framework)), /requires/);
  file(root, 'pubspec.yaml', 'name: dart_only\n');
  assert.throws(() => assertProject(root, spec('flutter')), /dependencies.flutter.sdk/);
  file(root, 'real-package.json', { dependencies: { expo: '53.0.0' } });
  rmSync(join(root, 'package.json'));
  symlinkSync('real-package.json', join(root, 'package.json'));
  assert.throws(() => assertProject(root, spec('expo')), /regular source file/);
});

test('caller-selected nested project does not silently fall back to workspace root', t => {
  const root = fixture(t);
  file(root, 'apps/mobile/package.json', manifests.expo['package.json']);
  assert.throws(() => assertProject(root, spec('expo')), /requires/);
  assert.doesNotThrow(() => assertProject(join(root, 'apps/mobile'), spec('expo')));
});

for (const framework of Object.keys(manifests)) {
  for (const platform of framework === 'mygo' ? ['macos'] : ['ios', 'android']) {
    if ((framework === 'android-java' && platform === 'ios') || (framework === 'swift' && platform === 'android')) continue;
    test(`doctor ${framework}/${platform} probes only the selected stack and platform`, () => {
      const commands = doctorCommands(framework, platform);
      assert.ok(commands.length);
      assert.equal(commands.some(command => command.argv[0] === 'flutter'), framework === 'flutter');
      assert.equal(commands.some(command => command.argv[0] === 'node'), ['react-native', 'expo'].includes(framework));
      assert.equal(commands.some(command => command.argv[0] === 'xcodebuild'), platform === 'ios');
      assert.equal(commands.some(command => command.argv[0] === 'java'), platform === 'android');
      assert.equal(commands.some(command => command.argv[0] === 'go'), framework === 'mygo');
      for (const command of commands) assert.ok(!command.argv.some(arg => ['install', 'prebuild', 'create', 'upgrade', 'eject'].includes(arg)));
    });
  }
}

test('native MyGo completion is Go-only and leaves unrelated frontend metadata alone', t => {
  const root = fixture(t);
  for (const [path, content] of Object.entries(manifests.mygo)) file(root, path, content);
  assert.doesNotThrow(() => assertProject(root, spec('mygo')));
  file(root, 'package.json', 'not a JavaScript project manifest');
  assert.doesNotThrow(() => assertProject(root, spec('mygo')));
});

for (const frontend of ['package.json', 'frontend/package.json']) {
  test(`web MyGo completion preserves the original ${frontend} without evaluating TypeScript`, t => {
    const root = fixture(t);
    file(root, 'go.mod', manifests.mygo['go.mod']);
    file(root, 'mygo.config.ts', 'export default (() => { throw new Error("must not execute during discovery"); })();');
    assert.throws(() => assertProject(root, spec('mygo')), /package.json/);
    file(root, frontend, { name: 'original-frontend', packageManager: 'npm@11.0.0', scripts: { build: 'vite build' } });
    assert.doesNotThrow(() => assertProject(root, spec('mygo')));
    file(root, frontend, []);
    assert.throws(() => assertProject(root, spec('mygo')), /manifest object/);
  });
}

test('MyGo requires one unambiguous native or web config', t => {
  const root = fixture(t);
  file(root, 'go.mod', manifests.mygo['go.mod']);
  assert.throws(() => assertProject(root, spec('mygo')), /exactly one/);
  file(root, 'mygo.json', { name: 'Native' });
  file(root, 'mygo.config.ts', 'export default {};');
  assert.throws(() => assertProject(root, spec('mygo')), /exactly one/);
  rmSync(join(root, 'mygo.config.ts'));
  for (const value of [[], null, '"not an object"', '{invalid']) {
    file(root, 'mygo.json', value);
    assert.throws(() => assertProject(root, spec('mygo')));
  }
});

for (const declaration of [
  '// require github.com/egoist/mygo v0.3.0\n',
  'require example.com/other v0.3.0 // github.com/egoist/mygo\n',
  'require github.com/egoist/mygo-extra v0.3.0\n',
  'replace github.com/egoist/mygo => github.com/owner/mygo v0.3.0\n',
  'tool github.com/egoist/mygo/cmd/mygo\n',
]) {
  test(`MyGo rejects a module without the actual dependency: ${declaration.trim()}`, t => {
    const root = fixture(t);
    file(root, 'go.mod', `module example.com/app\n\n${declaration}`);
    file(root, 'mygo.json', {});
    assert.throws(() => assertProject(root, spec('mygo')), /go.mod requiring github.com\/egoist\/mygo/);
  });
}

test('MyGo accepts quoted block requirements rather than matching comments as source', t => {
  const root = fixture(t);
  file(root, 'go.mod', 'module example.com/app\n\nrequire (\n // owner-selected version\n "github.com/egoist/mygo" v0.3.0 // indirect\n)\n');
  file(root, 'mygo.json', {});
  assert.doesNotThrow(() => assertProject(root, spec('mygo')));
});

for (const path of ['go.mod', 'mygo.json', 'mygo.config.ts', 'package.json', 'frontend/package.json']) {
  test(`MyGo rejects a symlinked ${path} manifest`, t => {
    const root = fixture(t);
    const web = !['go.mod', 'mygo.json'].includes(path);
    file(root, 'go.mod', manifests.mygo['go.mod']);
    file(root, web ? 'mygo.config.ts' : 'mygo.json', web ? 'export default {};' : {});
    if (web) file(root, path === 'frontend/package.json' ? path : 'package.json', {});
    const target = path === 'go.mod' ? manifests.mygo['go.mod'] : path === 'mygo.config.ts' ? 'export default {};' : {};
    file(root, 'real-manifest', target);
    rmSync(join(root, path), { force: true });
    symlinkSync(path.startsWith('frontend/') ? '../real-manifest' : 'real-manifest', join(root, path));
    assert.throws(() => assertProject(root, spec('mygo')), /regular source file/);
  });
}

test('MyGo uses only Go and macOS utility probes without requiring frontend or mobile tools', () => {
  assert.deepEqual(doctorCommands('mygo', 'macos').map(command => command.argv), [
    ['go', 'version'], ['/usr/bin/which', 'codesign'], ['hdiutil', 'help'],
  ]);
  for (const platform of ['ios', 'android']) assert.throws(() => doctorCommands('mygo', platform), /only macOS/);
  for (const framework of Object.keys(manifests).filter(framework => framework !== 'mygo')) {
    assert.throws(() => doctorCommands(framework, 'macos'), /only MyGo/);
  }
});

test('MyGo is the only new macOS project surface and does not expand existing stacks', t => {
  const root = fixture(t);
  for (const [path, content] of Object.entries(manifests.mygo)) file(root, path, content);
  for (const platform of ['ios', 'android']) assert.throws(() => assertProject(root, spec('mygo', platform)), /macOS platform/);
  for (const [framework, files] of Object.entries(manifests)) {
    if (framework === 'mygo') continue;
    const other = fixture(t);
    for (const [path, content] of Object.entries(files)) file(other, path, content);
    assert.throws(() => assertProject(other, spec(framework, 'macos')), /macOS is supported only for MyGo/);
  }
});

test('MyGo manifest detection uses the caller-selected project directory only', t => {
  const root = fixture(t);
  for (const [path, content] of Object.entries(manifests.mygo)) file(root, `apps/desktop/${path}`, content);
  assert.throws(() => assertProject(root, spec('mygo')), /go.mod/);
  assert.doesNotThrow(() => assertProject(join(root, 'apps/desktop'), spec('mygo')));
});

test('generated exclusions are framework-specific and preserve owned source directories', () => {
  for (const framework of Object.keys(manifests)) {
    assert.equal(isGeneratedPath('build/result.bin', framework), true);
    assert.equal(isGeneratedPath('lib/build/source.txt', framework), false);
    assert.equal(isGeneratedPath('android/app/src/main/App.java', framework), false);
    assert.equal(isGeneratedPath('ios/App/App.swift', framework), false);
  }
  assert.equal(isGeneratedPath('apps/mobile/node_modules/pkg/index.js', 'expo'), true);
  assert.equal(isGeneratedPath('apps/mobile/ios/Pods/pkg/source.m', 'react-native'), true);
  assert.equal(isGeneratedPath('native/.gradle/state', 'android-java'), true);
  assert.equal(isGeneratedPath('node_modules/owned.dart', 'flutter'), false);
  assert.equal(isGeneratedPath('.expo/cache', 'expo'), true);
  assert.equal(isGeneratedPath('.expo/owned', 'react-native'), false);
  assert.equal(isGeneratedPath('unpackage/app.apk', 'uni-app'), true);
  assert.equal(isGeneratedPath('unpackage/source.txt', 'swift'), false);
  assert.equal(isGeneratedPath('.dart_tool/package_config.json'), true);
});

for (const [framework, path, before, after] of [
  ['react-native', 'package-lock.json', { lockfileVersion: 3, packages: {} }, { lockfileVersion: 3, packages: { 'node_modules/pkg': { resolved: 'https://example.com/pkg.tgz', integrity: 'changed' } } }],
  ['expo', 'yarn.lock', 'pkg@1:\n  version "1.0.0"\n', 'pkg@1:\n  version "1.1.0"\n'],
  ['uni-app', 'pnpm-lock.yaml', 'lockfileVersion: "9.0"\npackages: {}\n', 'lockfileVersion: "9.0"\npackages:\n  pkg@1.1.0: {}\n'],
  ['swift', 'ios/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved', { pins: [{ identity: 'pkg', state: { revision: 'aaa' } }] }, { pins: [{ identity: 'pkg', state: { revision: 'bbb' } }] }],
  ['swift', 'ios/Podfile.lock', 'PODS:\n  - Pkg (1.0)\n', 'PODS:\n  - Pkg (1.1)\n'],
  ['android-java', 'gradle/dependency-locks/runtime.lockfile', 'pkg=1.0\n', 'pkg=1.1\n'],
]) {
  test(`${framework} fingerprints ${path}`, t => {
    const root = fixture(t);
    file(root, path, before);
    const digest = dependencyDigest(root, framework);
    file(root, path, after);
    assert.notEqual(dependencyDigest(root, framework), digest);
  });
}

test('owned JS workspace dependencies and their lib/build source participate in proof', t => {
  const root = fixture(t);
  file(root, 'apps/mobile/package.json', { name: 'mobile', dependencies: { shared: 'workspace:*' } });
  file(root, 'packages/shared/package.json', { name: 'shared', version: '1.0.0' });
  file(root, 'packages/shared/lib/build/value.js', 'export const value = 1;');
  assert.doesNotThrow(() => validateLocalDependencies(root, 'expo', 'apps/mobile'));
  const before = dependencyDigest(root, 'expo', 'apps/mobile');
  file(root, 'packages/shared/lib/build/value.js', 'export const value = 2;');
  assert.notEqual(dependencyDigest(root, 'expo', 'apps/mobile'), before);
});

test('pnpm importer local links resolve from the importer, not from the lockfile', t => {
  const root = fixture(t);
  file(root, 'apps/mobile/package.json', { name: 'mobile' });
  file(root, 'packages/shared/package.json', { name: 'shared' });
  file(root, 'pnpm-lock.yaml', 'lockfileVersion: "9.0"\nimporters:\n  apps/mobile:\n    dependencies:\n      shared:\n        specifier: workspace:*\n        version: link:../../packages/shared\n');
  assert.doesNotThrow(() => validateLocalDependencies(root, 'expo', 'apps/mobile'));
});

for (const value of ['file:../outside', 'link:../outside', 'portal:../outside', 'file:%2e%2e/outside', 'file:/tmp/external', '/tmp/external', 'file:build/local']) {
  test(`JS rejects unowned mutable dependency ${value}`, t => {
    const root = fixture(t);
    file(root, 'package.json', { dependencies: { owned: value } });
    file(root, 'build/local/package.json', { name: 'owned' });
    assert.throws(() => validateLocalDependencies(root, 'react-native'), /workspace-relative|escapes|outside fingerprinted/);
  });
}

test('npm lock-only file dependency escapes cannot evade declaration checks', t => {
  const root = fixture(t);
  file(root, 'package-lock.json', { lockfileVersion: 3, packages: { 'node_modules/pkg': { resolved: 'file:../outside' } } });
  assert.throws(() => dependencyDigest(root, 'expo'), /escapes/);
});

test('owned source symlinks are rejected even when their target remains inside the snapshot', t => {
  const root = fixture(t);
  file(root, 'packages/real/package.json', { name: 'real' });
  symlinkSync('real', join(root, 'packages/alias'), 'dir');
  assert.throws(() => validateLocalDependencies(root, 'expo'), /symlinks/);
});

test('generated JS caches are not source, but installation resolution records are proof', t => {
  const root = fixture(t);
  file(root, 'apps/mobile/package.json', { name: 'mobile' });
  file(root, 'apps/mobile/node_modules/pkg/index.js', 'module.exports = 1;');
  file(root, 'apps/mobile/node_modules/.package-lock.json', { lockfileVersion: 3, packages: {} });
  const before = dependencyDigest(root, 'expo', 'apps/mobile');
  file(root, 'apps/mobile/node_modules/pkg/index.js', 'module.exports = 2;');
  file(root, 'apps/mobile/build/output.js', 'generated output');
  assert.equal(dependencyDigest(root, 'expo', 'apps/mobile'), before);
  file(root, 'apps/mobile/node_modules/.package-lock.json', { lockfileVersion: 3, packages: { pkg: { version: '2' } } });
  assert.notEqual(dependencyDigest(root, 'expo', 'apps/mobile'), before);
});

for (const [framework, path, text] of [
  ['swift', 'Package.swift', '// swift-tools-version: 6.0\nlet package = Package(dependencies: [.package(path: "../outside")])'],
  ['swift', 'ios/Podfile', "pod 'Owned', :path => '../../outside'\n"],
  ['swift', 'ios/Podfile.lock', 'EXTERNAL SOURCES:\n  Owned:\n    :path: ../../outside\n'],
  ['swift', 'ios/App.xcodeproj/project.pbxproj', '{ isa = XCLocalSwiftPackageReference; relativePath = ../../outside; }'],
  ['android-java', 'settings.gradle', "includeBuild('../outside')\n"],
  ['android-java', 'app/build.gradle', "dependencies { implementation files('../../outside.jar') }\n"],
]) {
  test(`${framework} rejects external local native dependencies in ${path}`, t => {
    const root = fixture(t);
    file(root, path, text);
    assert.throws(() => validateLocalDependencies(root, framework));
  });
}

test('nested Flutter app validates sibling owned packages without activating unrelated fixtures', t => {
  const root = fixture(t);
  file(root, 'apps/mobile/pubspec.yaml', 'name: app\ndependencies:\n  flutter: {sdk: flutter}\n  shared: {path: ../../packages/shared}\n');
  file(root, 'packages/shared/pubspec.yaml', 'name: shared\n');
  file(root, 'fixtures/pubspec.yaml', 'name: inactive\ndependencies:\n  outside: {path: /unowned}\n');
  assert.doesNotThrow(() => validateLocalDependencies(root, 'flutter', 'apps/mobile'));
  assert.equal(dependencyDigest(root), dependencyDigest(root, 'flutter'));
  const before = dependencyDigest(root, 'flutter', 'apps/mobile');
  file(root, 'apps/mobile/.dart_tool/package_config.json', { configVersion: 2, packages: [] });
  assert.notEqual(dependencyDigest(root, 'flutter', 'apps/mobile'), before);
});

test('classic HBuilderX uni-app projects need no package.json or npm conversion', t => {
  const root = fixture(t);
  file(root, 'App.vue', '<script>export default {}</script>');
  file(root, 'main.js', "import App from './App.vue';");
  file(root, 'manifest.json', { name: 'Existing HBuilderX app' });
  file(root, 'pages.json', { pages: [{ path: 'pages/home/index' }] });
  assert.doesNotThrow(() => assertProject(root, spec('uni-app', 'android')));
  assert.doesNotThrow(() => validateLocalDependencies(root, 'uni-app'));
  assert.equal(doctorCommands('uni-app', 'android').some(command => ['node', 'npm', 'flutter'].includes(command.argv[0])), false);
  assert.match(buildInstructions(spec('uni-app')), /without requiring npm/);
});

test('only settings-declared regular Gradle modules gain generated build outputs', t => {
  const root = fixture(t);
  file(root, 'apps/mobile/settings.gradle.kts', 'include(":feature:search", ":shared")\nproject(":shared").projectDir = file("../../packages/shared")\n');
  file(root, 'apps/mobile/feature/search/build.gradle.kts', 'plugins { id("com.android.library") }');
  file(root, 'packages/shared/build.gradle', "plugins { id 'java-library' }");
  file(root, 'lib/build/source.js', 'owned source');
  const paths = generatedModulePaths(root, 'android-java', 'apps/mobile');
  assert.deepEqual([...paths].sort(), ['apps/mobile/feature/search/build', 'packages/shared/build']);
  assert.equal(paths.has('lib/build'), false);
  const before = dependencyDigest(root, 'android-java', 'apps/mobile');
  file(root, 'apps/mobile/feature/search/build/generated/source.java', 'generated');
  file(root, 'packages/shared/build/classes/Shared.class', 'generated');
  assert.equal(dependencyDigest(root, 'android-java', 'apps/mobile'), before);
  file(root, 'package.json', { dependencies: { untrusted: 'file:apps/mobile/feature/search/build' } });
  assert.throws(() => validateLocalDependencies(root, 'android-java', 'apps/mobile'), /outside fingerprinted/);
});

test('symlinked Gradle module manifests cannot establish an output exclusion', t => {
  const root = fixture(t);
  file(root, 'settings.gradle', "include ':feature'\n");
  file(root, 'owned.gradle', "plugins { id 'java-library' }");
  mkdirSync(join(root, 'feature'));
  symlinkSync('../owned.gradle', join(root, 'feature/build.gradle'));
  assert.throws(() => generatedModulePaths(root, 'android-java'), /symlink/);
});

test('native JS autolinking can reference an uninstalled owned cache but never an escaping cache', t => {
  const root = fixture(t);
  file(root, 'android/settings.gradle', "includeBuild('../node_modules/@react-native/gradle-plugin')\n");
  assert.doesNotThrow(() => validateLocalDependencies(root, 'react-native'));
  const external = fixture(t);
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(external, join(root, 'node_modules/@react-native'), 'dir');
  assert.throws(() => validateLocalDependencies(root, 'react-native'), /symlink|escapes/);
});

test('native-only caches do not hide unrelated profile source', () => {
  assert.equal(isGeneratedPath('Pods/owned.java', 'android-java'), false);
  assert.equal(isGeneratedPath('.gradle/owned.swift', 'swift'), false);
  assert.equal(isGeneratedPath('.build/owned.java', 'android-java'), false);
  assert.equal(isGeneratedPath('app/build/owned.swift', 'swift'), false);
});

test('commented Gradle includes never turn lib/build source into generated output', t => {
  const root = fixture(t);
  file(root, 'settings.gradle', "// include ':lib'\n/* include ':other' */\n");
  file(root, 'lib/build.gradle', "plugins { id 'java-library' }");
  file(root, 'lib/build/source.java', 'class Source {}');
  assert.deepEqual([...generatedModulePaths(root, 'android-java')], []);
});

test('inactive native dependency comments do not demand nonexistent local sources', t => {
  const root = fixture(t);
  file(root, 'Package.swift', '// .package(path: "../outside")\nlet package = Package(name: "App")');
  file(root, 'ios/Podfile', "# pod 'Outside', :path => '../../outside'\n");
  assert.doesNotThrow(() => validateLocalDependencies(root, 'swift'));
});

for (const [path, before, after] of [
  ['node_modules/.modules.yaml', 'layoutVersion: 5\n', 'layoutVersion: 6\n'],
  ['node_modules/.pnpm/lock.yaml', 'lockfileVersion: "9.0"\npackages: {}\n', 'lockfileVersion: "9.0"\npackages:\n  dep@2.0.0: {}\n'],
]) {
  test(`pnpm installed resolution ${path} participates in dependency proof`, t => {
    const root = fixture(t);
    file(root, path, before);
    const digest = dependencyDigest(root, 'expo');
    file(root, path, after);
    assert.notEqual(dependencyDigest(root, 'expo'), digest);
  });
}

test('npm version-only and link-only local resolutions cannot hide outside owned source', t => {
  const root = fixture(t);
  file(root, 'package-lock.json', { lockfileVersion: 1, dependencies: { pkg: { version: 'file:../outside' } } });
  assert.throws(() => validateLocalDependencies(root, 'expo'), /escapes/);
  file(root, 'package-lock.json', { lockfileVersion: 3, packages: { 'node_modules/pkg': { link: true, resolved: 'build/pkg' } } });
  assert.throws(() => validateLocalDependencies(root, 'expo'), /outside fingerprinted/);
  rmSync(join(root, 'package-lock.json'));
  file(root, 'node_modules/.package-lock.json', { lockfileVersion: 3, packages: { pkg: { resolved: 'file:../outside' } } });
  assert.throws(() => validateLocalDependencies(root, 'expo'), /escapes/);
});

test('Swift generated package resolution is proof while ordinary build output is not', t => {
  const root = fixture(t);
  file(root, 'Package.swift', '// swift-tools-version: 6.0\nlet package = Package(name: "App")');
  const clean = dependencyDigest(root, 'swift');
  file(root, 'build/Products/App.app/App', 'generated executable');
  assert.equal(dependencyDigest(root, 'swift'), clean);
  file(root, '.build/workspace-state.json', { object: { dependencies: [{ packageRef: { kind: 'remoteSourceControl', location: 'https://example.com/pkg' }, state: { revision: 'aaa' } }] } });
  const before = dependencyDigest(root, 'swift');
  file(root, '.build/workspace-state.json', { object: { dependencies: [{ packageRef: { kind: 'remoteSourceControl', location: 'https://example.com/pkg' }, state: { revision: 'bbb' } }] } });
  assert.notEqual(dependencyDigest(root, 'swift'), before);
  const outside = fixture(t);
  file(root, '.build/workspace-state.json', { object: { dependencies: [{ packageRef: { kind: 'fileSystem', location: outside } }] } });
  assert.throws(() => validateLocalDependencies(root, 'swift'), /escapes/);
});

for (const [framework, path, text] of [
  ['swift', 'Package.swift', 'let package = Package(dependencies: [.package(url: "file:///external/repository", from: "1.0.0")])'],
  ['swift', 'Podfile', "pod 'Pkg', :git => 'file:///external/repository'\n"],
  ['android-java', 'build.gradle', "repositories { maven { url uri('../external-repository') } }\n"],
]) {
  test(`local repository references cannot bypass ownership in ${path}`, t => {
    const root = fixture(t);
    file(root, path, text);
    assert.throws(() => validateLocalDependencies(root, framework), /workspace-relative|escapes/);
  });
}

test('only selected settings and explicitly included builds establish module outputs', t => {
  const root = fixture(t);
  file(root, 'settings.gradle', "includeBuild('plugins')\n");
  file(root, 'plugins/settings.gradle.kts', 'include(":tool")\n');
  file(root, 'plugins/tool/build.gradle.kts', 'plugins { `java-library` }');
  file(root, 'fixtures/settings.gradle', "include ':lib'\n");
  file(root, 'fixtures/lib/build.gradle', "plugins { id 'java-library' }");
  assert.deepEqual([...generatedModulePaths(root, 'android-java')], ['plugins/tool/build']);
});

for (const collection of ['files', 'dirs']) {
  test(`Gradle ${collection} proves every literal collection path`, t => {
    const root = fixture(t);
    const outside = fixture(t);
    file(root, 'owned/first/value.txt', 'first');
    file(root, 'owned/second/value.txt', 'second');
    for (const external of [outside, '../outside']) {
      file(root, 'build.gradle', `dependencies { implementation ${collection}('owned/first', '${external}') }`);
      assert.throws(() => dependencyDigest(root, 'android-java'), /workspace-relative|escapes/);
    }
    file(root, 'build.gradle', `// ${collection}('../ignored')\ndependencies { implementation ${collection}('owned/first', 'owned/second') }`);
    const before = dependencyDigest(root, 'android-java');
    file(root, 'owned/second/value.txt', 'changed second');
    assert.notEqual(dependencyDigest(root, 'android-java'), before);
    file(root, 'build.gradle', `${collection}('owned/first', computedPath)`);
    assert.throws(() => validateLocalDependencies(root, 'android-java'), /Cannot prove Gradle/);
  });
}

test('Gradle literal dirs without parentheses and installed JS autolinks remain supported', t => {
  const root = fixture(t);
  file(root, 'android/build.gradle', `repositories { flatDir { dirs '../owned', '../node_modules/pkg/android/libs' } }\ndependencies { implementation files('../node_modules/pkg/android/library.jar') }`);
  file(root, 'owned/local.jar', 'owned');
  assert.doesNotThrow(() => validateLocalDependencies(root, 'react-native'));
  const before = dependencyDigest(root, 'react-native');
  file(root, 'owned/local.jar', 'changed');
  assert.notEqual(dependencyDigest(root, 'react-native'), before);
});

for (const directory of ['.', 'apps/mobile']) {
  test(`Swift DerivedData resolution tracks installed metadata for ${directory}`, t => {
    const root = fixture(t);
    const metadata = join(directory, 'build/DerivedData/SourcePackages/workspace-state.json');
    file(root, join(directory, 'Package.swift'), 'let package = Package(name: "App")');
    const resolution = revision => ({ object: { dependencies: [{ packageRef: { kind: 'remoteSourceControl', location: 'https://example.com/pkg' }, state: { revision } }] } });
    file(root, metadata, resolution('aaa'));
    const before = dependencyDigest(root, 'swift', directory);
    file(root, join(directory, 'build/DerivedData/Build/Products/App'), 'generated executable');
    file(root, join(directory, 'build/DerivedData/SourcePackages/checkouts/pkg/source.swift'), 'generated checkout');
    assert.equal(dependencyDigest(root, 'swift', directory), before);
    file(root, metadata, resolution('bbb'));
    assert.notEqual(dependencyDigest(root, 'swift', directory), before);
    file(root, join(directory, 'packages/local/value.swift'), 'owned local package');
    file(root, metadata, { object: { dependencies: [{ packageRef: { kind: 'fileSystem', location: 'packages/local' } }] } });
    const localBefore = dependencyDigest(root, 'swift', directory);
    file(root, join(directory, 'packages/local/value.swift'), 'changed local package');
    assert.notEqual(dependencyDigest(root, 'swift', directory), localBefore);
    const outside = fixture(t);
    for (const kind of ['fileSystem', 'localSourceControl']) {
      file(root, metadata, { object: { dependencies: [{ packageRef: { kind, location: outside } }] } });
      assert.throws(() => dependencyDigest(root, 'swift', directory), /escapes/);
    }
  });
}

test('Swift installed resolution records cannot traverse a generated directory symlink', t => {
  const root = fixture(t);
  const outside = fixture(t);
  file(outside, 'SourcePackages/workspace-state.json', { object: { dependencies: [] } });
  mkdirSync(join(root, 'build'));
  symlinkSync(outside, join(root, 'build/DerivedData'));
  assert.throws(() => validateLocalDependencies(root, 'swift'), /source symlink/);
});

test('Gradle collection scanning skips quoted text, identifier prefixes and consumed path arguments', t => {
  const root = fixture(t);
  file(root, 'libs/files.jar', 'first owned library');
  file(root, 'libs/files(1).jar', 'second owned library');
  file(root, 'libs/dirs/value.txt', 'owned directory');
  file(root, 'build.gradle', `def filesDirectory = "files('../not-a-dependency')"\ndef dirsMetadata = 'dirs("../also-not-a-dependency")'\ndependencies { implementation files('libs/files.jar', 'libs/files(1).jar') }\nrepositories { flatDir { dirs 'libs/dirs' } }\n`);
  const before = dependencyDigest(root, 'android-java');
  file(root, 'libs/files(1).jar', 'modified second owned library');
  assert.notEqual(dependencyDigest(root, 'android-java'), before);
});

test('Gradle declarations and native references inside literals never acquire ownership', t => {
  const root = fixture(t);
  file(root, 'settings.gradle', `
def diagnostic = "include ':lib'"
def multiline = '''include ':lib'
includeBuild('../outside')
project(':actual').projectDir = file('../outside')
'''
// include ':lib'
/* includeBuild('../outside') */
include 'actual'
def remapDiagnostic = "project(':actual').projectDir = file('lib')"
`);
  file(root, 'actual/build.gradle', `
def references = """includeBuild('../outside')
projectDir = file('../outside')
fileTree(dir: '../outside')
url uri('../outside')
files('../outside')
dirs('../outside')"""
def quoted = "fileTree(dir: '../outside')"
`);
  file(root, 'lib/build.gradle', 'plugins { id "java-library" }');
  file(root, 'lib/build/gradle.properties', 'owned=first');
  assert.deepEqual([...generatedModulePaths(root, 'android-java')], ['actual/build']);
  const source = sourceDigest(root, true, 'android-java');
  const dependencies = dependencyDigest(root, 'android-java');
  file(root, 'lib/build/gradle.properties', 'owned=second');
  assert.notEqual(sourceDigest(root, true, 'android-java'), source);
  assert.notEqual(dependencyDigest(root, 'android-java'), dependencies);
});

test('colon-optional Gradle module IDs and remaps share output ownership', t => {
  const root = fixture(t);
  file(root, 'settings.gradle.kts', `include("feature:search", ":shared", "tools")
project("shared").projectDir = file("packages/shared")
project(":tools").projectDir = file("packages/tools")
`);
  for (const path of ['feature/search', 'packages/shared', 'packages/tools']) {
    file(root, `${path}/build.gradle.kts`, 'plugins { `java-library` }');
  }
  const paths = ['feature/search/build', 'packages/shared/build', 'packages/tools/build'];
  assert.deepEqual([...generatedModulePaths(root, 'android-java')].sort(), paths);
  const source = sourceDigest(root, true, 'android-java');
  const dependencies = dependencyDigest(root, 'android-java');
  for (const path of paths) file(root, `${path}/gradle.properties`, 'generated=true');
  assert.equal(sourceDigest(root, true, 'android-java'), source);
  assert.equal(dependencyDigest(root, 'android-java'), dependencies);
});

test('only active included build roots with regular manifests exclude root outputs', t => {
  const root = fixture(t);
  file(root, 'settings.gradle', "includeBuild('plugins')\nincludeBuild('manifestless')\n");
  file(root, 'plugins/build.gradle.kts', 'plugins { `java-library` }');
  file(root, 'manifestless/build/gradle.properties', 'owned=true');
  file(root, 'fixtures/build.gradle', 'plugins { id "java-library" }');
  file(root, 'fixtures/build/gradle.properties', 'owned=true');
  assert.deepEqual([...generatedModulePaths(root, 'android-java')], ['plugins/build']);
  const source = sourceDigest(root, true, 'android-java');
  const dependencies = dependencyDigest(root, 'android-java');
  file(root, 'plugins/build/gradle.properties', 'generated=true');
  assert.equal(sourceDigest(root, true, 'android-java'), source);
  assert.equal(dependencyDigest(root, 'android-java'), dependencies);
  for (const path of ['manifestless', 'fixtures']) {
    const beforeSource = sourceDigest(root, true, 'android-java');
    const beforeDependencies = dependencyDigest(root, 'android-java');
    file(root, `${path}/build/gradle.properties`, 'owned=changed');
    assert.notEqual(sourceDigest(root, true, 'android-java'), beforeSource);
    assert.notEqual(dependencyDigest(root, 'android-java'), beforeDependencies);
  }
});

for (const kind of ['manifest', 'directory', 'escaping output']) {
  test(`included Gradle build refuses symlinked ${kind}`, t => {
    const root = fixture(t);
    file(root, 'settings.gradle', "includeBuild('plugins')\n");
    file(root, 'owned/build.gradle', 'plugins { id "java-library" }');
    if (kind === 'directory') {
      symlinkSync('owned', join(root, 'plugins'), 'dir');
    } else {
      mkdirSync(join(root, 'plugins'));
      if (kind === 'manifest') symlinkSync('../owned/build.gradle', join(root, 'plugins/build.gradle'));
      else {
        file(root, 'plugins/build.gradle', 'plugins { id "java-library" }');
        symlinkSync(fixture(t), join(root, 'plugins/build'), 'dir');
      }
    }
    assert.throws(() => sourceDigest(root, true, 'android-java'), /symlink/);
  });
}

for (const mode of ['dependencies', 'profile']) {
  test(`${mode} revalidates a replaced directory before traversing outside owned source`, t => {
    const root = fixture(t), outside = fixture(t);
    mkdirSync(join(root, 'owned'));
    file(root, 'owned/Inside.xcodeproj/project.pbxproj', '{ isa = PBXProject; }');
    file(outside, 'Package.swift', '// swift-tools-version: 6.0\nlet package = Package(name: "Outside")');
    file(outside, 'Outside.xcodeproj/project.pbxproj', '{ isa = PBXProject; }');
    const external = fs.realpathSync(outside);
    const original = fs.readdirSync;
    let swapped = false, externalTraversal = false;
    fs.readdirSync = function (directory, options) {
      if (fs.realpathSync(directory).startsWith(external)) externalTraversal = true;
      const entries = original.call(this, directory, options);
      if (directory === root && options?.withFileTypes && !swapped) {
        swapped = true;
        fs.renameSync(join(root, 'owned'), join(root, 'retired'));
        symlinkSync(outside, join(root, 'owned'), 'dir');
      }
      return entries;
    };
    syncBuiltinESMExports();
    try {
      assert.throws(() => mode === 'dependencies' ? dependencyDigest(root, 'swift') : assertProject(root, spec('swift')));
      assert.equal(swapped, true);
      assert.equal(externalTraversal, false);
    } finally {
      fs.readdirSync = original;
      syncBuiltinESMExports();
    }
  });
}
