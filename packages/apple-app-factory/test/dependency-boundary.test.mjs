import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inside } from '../dist/config.js';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { executeStep } from '../dist/runner.js';
import { prepareWorkspace, sourceDigest } from '../dist/workspace.js';
import { dependencyDigest } from '../dist/dependencies.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-dependency-boundary-'));
  const workspace = join(root, 'app');
  mkdirSync(workspace);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace };
}

function file(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function packageSource(directory, name, dependencies = '') {
  file(join(directory, 'pubspec.yaml'), `name: ${name}\n${dependencies}`);
  file(join(directory, 'lib', 'value.dart'), 'int value = 1;\n');
}

for (const dangling of [false, true]) {
  test(`a missing output rejects an ${dangling ? 'dangling' : 'escaping'} generated ancestor before compiler writes`, async t => {
    const f = fixture(t);
    const outside = join(f.root, 'outside');
    if (!dangling) mkdirSync(outside);
    symlinkSync(outside, join(f.workspace, 'build'), 'dir');
    const output = join(outside, 'ios', 'ipa');
    assert.throws(() => inside(f.workspace, 'build/ios/ipa'), /symlink/);
    assert.equal(existsSync(output), false);
    const compilerMarker = join(f.root, 'compiler-started');
    const command = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(compilerMarker)}, 'started')`];
    const config = ConfigSchema.parse({ stateDir: join(f.root, 'state'), workspaceRoot: join(f.root, 'workspaces'), packageTarget: 'simulator', allowLocalExecution: true,
      verification: { checks: [command], runtime: [command] } });
    const store = new Store(config.stateDir);
    t.after(() => store.close());
    const job = store.enqueue({ id: 'boundary-product', name: 'Boundary product', purpose: 'Preserve owned sources', audience: 'Owners', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Owned dependencies'], acceptance: ['Reject escaping output'] }, config);
    mkdirSync(job.workspace, { recursive: true });
    symlinkSync(outside, join(job.workspace, 'build'), 'dir');
    const result = await executeStep(store, store.update(job.id, { stage: 'verify', status: 'running' }));
    assert.match(result.error, /symlink/);
    assert.equal(existsSync(compilerMarker), false);
    assert.equal(existsSync(output), false);
  });
}

test('normal missing destinations stay inside and are not created by validation', t => {
  const { workspace } = fixture(t);
  assert.equal(inside(workspace, 'build/ios/ipa'), join(workspace, 'build/ios/ipa'));
  assert.doesNotThrow(() => sourceDigest(workspace));
  assert.equal(existsSync(join(workspace, 'build')), false);
});

for (const location of ['../shared_package', 'build/local_package', '.factory-cache/local_package', '.dart_tool/local_package', 'ios/Pods/local_package']) {
  for (const transitive of [false, true]) {
    test(`${transitive ? 'transitive' : 'direct'} path dependency ${location} cannot escape the fingerprint`, t => {
      const { workspace } = fixture(t);
      const target = join(workspace, location);
      packageSource(target, 'local_package');
      if (transitive) {
        const middle = join(workspace, 'packages', 'middle');
        packageSource(middle, 'middle', `dependencies:\n  local_package: {path: ${JSON.stringify(relative(middle, target))}}\n`);
        packageSource(workspace, 'app', 'dependencies:\n  middle: {path: packages/middle}\n');
      } else packageSource(workspace, 'app', `dependencies:\n  local_package: {path: ${JSON.stringify(location)}}\n`);
      assert.throws(() => sourceDigest(workspace), /outside fingerprinted workspace source/);
    });
  }
}

for (const location of ['../transitive', 'build/transitive', '.factory-cache/transitive']) {
  test(`locked transitive path ${location} is checked when a hosted dependency introduced it`, t => {
    const { workspace } = fixture(t);
    packageSource(workspace, 'app', 'dependencies:\n  hosted_package: ^1.0.0\n');
    packageSource(join(workspace, location), 'transitive');
    file(join(workspace, 'pubspec.lock'), `packages:\n  hosted_package:\n    source: hosted\n    version: "1.0.0"\n  transitive:\n    source: path\n    description:\n      path: ${JSON.stringify(location)}\n      relative: true\n    version: "1.0.0"\n`);
    assert.throws(() => sourceDigest(workspace), /outside fingerprinted workspace source/);
  });
}

test('root overrides and YAML aliases resolve local dependencies without parsing unrelated fixture manifests', t => {
  const { root, workspace } = fixture(t);
  packageSource(workspace, 'app', 'dependencies:\n  local_package: ^1.0.0\ndependency_overrides:\n  local_package: &local {path: packages/local}\n  unused_package: *local\n');
  packageSource(join(workspace, 'packages', 'local'), 'local_package');
  packageSource(join(workspace, 'test', 'fixtures', 'unused'), 'unused', 'dependencies:\n  external: {path: ../../../../outside}\n');
  assert.doesNotThrow(() => sourceDigest(workspace));
  packageSource(join(root, 'outside'), 'local_package');
  file(join(workspace, 'pubspec_overrides.yaml'), 'dependency_overrides:\n  local_package: {path: ../outside}\n');
  assert.throws(() => sourceDigest(workspace), /outside fingerprinted workspace source/);
});

test('root overrides apply to transitive declarations relative to the application', t => {
  const { root, workspace } = fixture(t);
  packageSource(workspace, 'app', 'dependencies:\n  middle: {path: packages/middle}\ndependency_overrides:\n  leaf: {path: ../outside}\n');
  packageSource(join(workspace, 'packages', 'middle'), 'middle', 'dependencies:\n  leaf: ^1.0.0\n');
  packageSource(join(root, 'outside'), 'leaf');
  assert.throws(() => sourceDigest(workspace), /outside fingerprinted workspace source/);
});

test('hosted, SDK and git packages are not mistaken for mutable path packages', t => {
  const { root, workspace } = fixture(t);
  packageSource(workspace, 'app', 'dependencies:\n  flutter: {sdk: flutter}\n  hosted_package: ^1.0.0\n  git_package: {git: "https://example.invalid/package"}\n');
  file(join(workspace, 'pubspec.lock'), 'packages:\n  flutter: {source: sdk, version: "1.0.0"}\n  hosted_package: {source: hosted, version: "1.0.0"}\n  git_package: {source: git, version: "1.0.0"}\n');
  file(join(workspace, '.dart_tool', 'package_config.json'), JSON.stringify({ configVersion: 2, packages: [
    { name: 'app', rootUri: '../' },
    { name: 'flutter', rootUri: pathToFileURL(join(root, 'sdk', 'packages', 'flutter')).href },
    { name: 'hosted_package', rootUri: pathToFileURL(join(workspace, '.factory-cache', 'pub', 'hosted_package')).href },
    { name: 'git_package', rootUri: pathToFileURL(join(root, 'pub-cache', 'git_package')).href },
  ] }));
  assert.doesNotThrow(() => sourceDigest(workspace));
});

test('resolved local paths cannot disagree with declarations or hide under generated directories', t => {
  const { workspace } = fixture(t);
  packageSource(workspace, 'app', 'dependencies:\n  local_package: {path: packages/local}\n');
  packageSource(join(workspace, 'packages', 'local'), 'local_package');
  packageSource(join(workspace, 'build', 'local'), 'local_package');
  file(join(workspace, '.dart_tool', 'package_config.json'), JSON.stringify({ configVersion: 2, packages: [{ name: 'local_package', rootUri: '../build/local' }] }));
  assert.throws(() => sourceDigest(workspace), /outside fingerprinted workspace source/);
  packageSource(join(workspace, 'packages', 'other'), 'local_package');
  file(join(workspace, '.dart_tool', 'package_config.json'), JSON.stringify({ configVersion: 2, packages: [{ name: 'local_package', rootUri: '../packages/other' }] }));
  assert.throws(() => sourceDigest(workspace), /differs from its declared path/);
});

test('owned direct and transitive package mutations change the digest; transitive dev fixtures stay inactive', t => {
  const { workspace } = fixture(t);
  packageSource(workspace, 'app', 'dependencies:\n  middle: {path: packages/middle}\n');
  packageSource(join(workspace, 'packages', 'middle'), 'middle', 'dependencies:\n  leaf: {path: ../leaf}\ndev_dependencies:\n  unused_fixture: {path: ../../../../outside}\n');
  packageSource(join(workspace, 'packages', 'leaf'), 'leaf');
  const before = sourceDigest(workspace);
  file(join(workspace, 'packages', 'leaf', 'lib', 'value.dart'), 'int value = 2;\n');
  assert.notEqual(sourceDigest(workspace), before);
});

test('successors retain owned package sources and validate before predecessor copying', async t => {
  const { root } = fixture(t);
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator', allowLocalExecution: true,
    verification: { prerequisites: [[process.execPath, '-e', 'process.exit(1)']], checks: [['unused']], runtime: [['unused']] } });
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  const spec = { id: 'owned-packages', name: 'Owned packages', purpose: 'Keep local packages', audience: 'Owners', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Verified local packages'], acceptance: ['Retain package source'] };
  const base = store.enqueue(spec, config);
  packageSource(base.workspace, 'app', 'dependencies:\n  middle: {path: packages/middle}\n');
  packageSource(join(base.workspace, 'packages', 'middle'), 'middle', 'dependencies:\n  leaf: {path: ../leaf}\n');
  packageSource(join(base.workspace, 'packages', 'leaf'), 'leaf');
  file(join(base.workspace, 'build', 'unused'), 'generated');
  const digest = sourceDigest(base.workspace);
  store.update(base.id, { status: 'built', stage: 'package', verifiedDigest: digest, verifiedDependencyDigest: dependencyDigest(base.workspace, spec.framework) });
  const successor = store.enqueue({ ...spec, version: '1.1.0' }, config, base.id);
  const result = await executeStep(store, store.update(successor.id, { stage: 'verify', status: 'running' }));
  assert.equal(result.basePrepared, true);
  assert.equal(result.blockedReason.kind, 'prerequisite');
  assert.equal(sourceDigest(result.workspace), digest);
  assert.equal(readFileSync(join(result.workspace, 'packages', 'leaf', 'lib', 'value.dart'), 'utf8'), 'int value = 1;\n');
  assert.equal(existsSync(join(result.workspace, 'build')), false);
  const rejected = store.enqueue({ ...spec, version: '1.2.0' }, config, base.id);
  packageSource(join(root, 'outside'), 'leaf');
  file(join(base.workspace, 'packages', 'middle', 'pubspec.yaml'), `name: middle\ndependencies:\n  leaf: {path: ${JSON.stringify(relative(join(base.workspace, 'packages', 'middle'), join(root, 'outside')))}}\n`);
  const blocked = await executeStep(store, store.update(rejected.id, { stage: 'verify', status: 'running' }));
  assert.match(blocked.error, /outside fingerprinted workspace source/);
  assert.equal(existsSync(rejected.workspace), false);
});

test('Gradle successor snapshot retains quoted-declaration source and omits active module outputs', t => {
  const { root } = fixture(t);
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'apk', verification: { checks: [['unused']], runtime: [['unused']] }, packaging: { provider: 'local', commands: [['unused']], artifactPath: 'build/App.apk' } });
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  const spec = { id: 'gradle-owned-source', name: 'Gradle owned source', purpose: 'Keep Gradle source boundaries', audience: 'Owners', framework: 'android-java', platform: 'android', channel: 'local', version: '1.0.0', differentiators: ['Owned source'], acceptance: ['Copy only owned bytes'] };
  const base = store.enqueue(spec, config);
  file(join(base.workspace, 'settings.gradle'), `def diagnostic = "include ':lib'"
include 'feature:search'
include ':shared'
project('shared').projectDir = file('packages/shared')
includeBuild('plugins')
includeBuild('manifestless')
`);
  for (const path of ['lib', 'feature/search', 'packages/shared', 'plugins', 'fixtures']) {
    file(join(base.workspace, path, 'build.gradle'), 'plugins { id "java-library" }');
    file(join(base.workspace, path, 'build', 'gradle.properties'), `${path}=original`);
  }
  file(join(base.workspace, 'manifestless/build/gradle.properties'), 'manifestless=owned');
  const digest = sourceDigest(base.workspace, true, spec.framework);
  const dependencies = dependencyDigest(base.workspace, spec.framework);
  store.update(base.id, { status: 'built', stage: 'package', verifiedDigest: digest, verifiedDependencyDigest: dependencies });
  const successor = store.enqueue({ ...spec, version: '1.1.0' }, config, base.id);
  for (const path of ['feature/search', 'packages/shared', 'plugins']) {
    file(join(base.workspace, path, 'build', 'gradle.properties'), 'generated=changed');
  }
  assert.equal(sourceDigest(base.workspace, true, spec.framework), digest);
  assert.equal(dependencyDigest(base.workspace, spec.framework), dependencies);
  prepareWorkspace(store, successor);
  assert.equal(store.get(successor.id).basePrepared, true);
  assert.equal(sourceDigest(successor.workspace, true, spec.framework), digest);
  assert.equal(dependencyDigest(successor.workspace, spec.framework), dependencies);
  for (const path of ['lib', 'fixtures']) {
    assert.equal(readFileSync(join(successor.workspace, path, 'build', 'gradle.properties'), 'utf8'), `${path}=original`);
  }
  assert.equal(readFileSync(join(successor.workspace, 'manifestless/build/gradle.properties'), 'utf8'), 'manifestless=owned');
  for (const path of ['feature/search', 'packages/shared', 'plugins']) {
    assert.equal(existsSync(join(successor.workspace, path, 'build')), false);
  }
  const rejected = store.enqueue({ ...spec, version: '1.2.0' }, config, base.id);
  file(join(base.workspace, 'lib/build/gradle.properties'), 'owned=changed');
  assert.notEqual(sourceDigest(base.workspace, true, spec.framework), digest);
  assert.notEqual(dependencyDigest(base.workspace, spec.framework), dependencies);
  assert.throws(() => prepareWorkspace(store, rejected), /source changed/);
  assert.equal(existsSync(rejected.workspace), false);
});
