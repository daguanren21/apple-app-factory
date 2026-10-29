import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { nextTurn, completeTurn, executeStep } from '../dist/runner.js';
import { runStep } from '../dist/scheduler.js';
import { sourceDigest } from '../dist/workspace.js';
import { dependencyDigest } from '../dist/dependencies.js';
import { run } from '../dist/process.js';

const cli = resolve('dist/cli.js');
const research = { viable: true, distinctness: 'Controlled lifecycle fixture; not a store approval claim.', risks: [], plan: ['Exercise the configured local workflow.'] };
const profiles = [
  ['flutter', 'android', 'apk'], ['android-java', 'android', 'aab'], ['swift', 'ios', 'ipa'],
  ['react-native', 'ios', 'simulator'], ['expo', 'android', 'apk'], ['uni-app', 'android', 'aab'],
];

function file(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function project(root, framework) {
  file(join(root, 'model.json'), JSON.stringify({ limit: 12, weights: [2, 3, 4] }));
  if (framework === 'flutter') {
    file(join(root, 'pubspec.yaml'), 'name: lifecycle_fixture\ndependencies:\n  flutter: {sdk: flutter}\n');
    file(join(root, 'lib/main.dart'), 'void main() {}\n');
  } else if (framework === 'android-java') {
    file(join(root, 'settings.gradle'), "rootProject.name = 'LifecycleFixture'\ninclude ':app'\n");
    file(join(root, 'app/build.gradle'), "plugins { id 'com.android.application' }\nandroid { namespace 'org.example.lifecycle'; compileSdk 35 }\n");
    file(join(root, 'app/src/main/AndroidManifest.xml'), '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="Lifecycle fixture" /></manifest>');
    file(join(root, 'app/src/main/java/org/example/lifecycle/Main.java'), 'package org.example.lifecycle; final class Main {}\n');
  } else if (framework === 'swift') {
    file(join(root, 'Package.swift'), '// swift-tools-version: 5.9\nimport PackageDescription\nlet package = Package(name: "LifecycleFixture", targets: [.executableTarget(name: "LifecycleFixture")])\n');
    file(join(root, 'Sources/LifecycleFixture/main.swift'), 'print("Lifecycle fixture")\n');
  } else {
    const dependency = framework === 'react-native' ? 'react-native' : framework === 'expo' ? 'expo' : '@dcloudio/uni-app';
    file(join(root, 'package.json'), JSON.stringify({ name: 'lifecycle-fixture', version: '1.0.0', dependencies: { [dependency]: '*' } }));
    file(join(root, 'index.js'), 'export const fixture = true;\n');
    if (framework === 'expo') file(join(root, 'app.json'), JSON.stringify({ expo: { name: 'Lifecycle fixture', slug: 'lifecycle-fixture' } }));
    if (framework === 'uni-app') {
      file(join(root, 'manifest.json'), '{}');
      file(join(root, 'pages.json'), JSON.stringify({ pages: [{ path: 'pages/index/index' }] }));
      file(join(root, 'pages/index/index.vue'), '<template><view>Lifecycle fixture</view></template>');
    }
  }
}

function fixture(t, framework = 'expo', platform = 'android', target = 'apk', overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apphx-multistack-'));
  const runtimeLog = join(root, 'runtime.json');
  const packagingLog = join(root, 'packaging.log');
  const artifactPath = `build/fixture.${target === 'simulator' ? 'app' : target}`;
  // These real Node child processes test orchestration and evidence, not any SDK/compiler.
  const packagingScript = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(packagingLog)},'package\\n');fs.mkdirSync('build',{recursive:true});${target === 'simulator' ? `fs.mkdirSync(${JSON.stringify(artifactPath)});fs.writeFileSync(${JSON.stringify(`${artifactPath}/Runner`)},'controlled process output');` : `fs.writeFileSync(${JSON.stringify(artifactPath)},'controlled process output');`}`;
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: target,
    allowLocalExecution: true, retryDelayMs: 1,
    verification: {
      prerequisites: [],
      checks: [[process.execPath, '-e', "const model=require('./model.json');require('node:assert/strict').ok(Array.isArray(model.weights)&&Number.isFinite(model.limit));"]],
      runtime: [[process.execPath, '-e', `const model=require('./model.json');const total=model.weights.reduce((sum,value)=>sum+value,0);require('node:assert/strict').equal(total,9);require('node:assert/strict').ok(total<=model.limit);require('node:fs').writeFileSync(${JSON.stringify(runtimeLog)},JSON.stringify({cwd:process.cwd(),total}));`]],
    },
    packaging: { commands: [[process.execPath, '-e', packagingScript]], artifactPath }, ...overrides });
  const spec = { id: 'lifecycle-product', name: 'Lifecycle product', framework, platform, channel: 'local', version: '1.0.0', purpose: 'Plan an offline load', audience: 'Travelers', differentiators: ['Owned local workflow'], acceptance: ['Calculate the configured total without network access'] };
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, runtimeLog, packagingLog, config, spec, store };
}

function reviewFor(job) {
  return { approved: true, findings: [], acceptanceEvidence: job.spec.acceptance.map(requirement => ({ requirement, evidence: 'Controlled runtime process asserted total=9 and persisted its execution result; not SDK/device evidence.' })) };
}

async function approved(f, spec = f.spec) {
  const job = f.store.enqueue(spec, f.config);
  const assessment = await nextTurn(f.store, job.id);
  assert.equal(assessment.turn.stage, 'research');
  completeTurn(f.store, job.id, assessment.turn.id, research);
  const build = await nextTurn(f.store, job.id);
  project(build.turn.cwd, spec.framework);
  completeTurn(f.store, job.id, build.turn.id);
  const verified = await runStep(f.store, f.config, job.id);
  assert.equal(verified.stage, 'review', verified.error);
  const review = await nextTurn(f.store, job.id);
  return completeTurn(f.store, job.id, review.turn.id, reviewFor(review.job));
}

for (const [framework, platform, target] of profiles) {
  test(`${framework}: CLI lifecycle reaches a hashed local ${target} through configured real processes without Apple setup`, { skip: platform === 'ios' && process.platform !== 'darwin' }, async t => {
    const f = fixture(t, framework, platform, target);
    const configPath = join(f.root, 'factory.json');
    writeFileSync(configPath, JSON.stringify(f.config));
    async function invoke(args, value) {
      const result = await run([process.execPath, cli, ...args, '--config', configPath], { input: value === undefined ? undefined : JSON.stringify(value) });
      assert.equal(result.code, 0, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    }
    const job = await invoke(['enqueue', '-'], f.spec);
    const first = await invoke(['next', job.id]);
    assert.equal(first.turn.stage, 'research');
    await invoke(['complete', job.id, first.turn.id, '-'], research);
    const build = await invoke(['next', job.id]);
    assert.equal(build.turn.stage, 'build');
    project(build.turn.cwd, framework);
    await invoke(['complete', job.id, build.turn.id]);
    assert.equal(existsSync(f.runtimeLog), false);
    const verified = await invoke(['step', job.id]);
    assert.equal(verified.stage, 'review');
    assert.equal(JSON.parse(readFileSync(f.runtimeLog)).total, 9);
    const review = await invoke(['next', job.id]);
    await invoke(['complete', job.id, review.turn.id, '-'], reviewFor(review.job));
    await invoke(['step', job.id]);
    const built = await invoke(['status', job.id]);
    assert.equal(built.status, 'built');
    assert.equal(built.artifact.kind, target === 'simulator' ? 'ios-simulator' : target);
    const digest = target === 'simulator' ? sourceDigest(built.artifact.path, false) : createHash('sha256').update(readFileSync(built.artifact.path)).digest('hex');
    assert.equal(built.artifact.digest, digest);
    assert.equal(built.verifiedDigest, sourceDigest(built.workspace, true, framework));
    assert.deepEqual(built.receipt, {});
    assert.equal(built.hostTurns, 3);
    assert.deepEqual(built.groups, []);
    assert.deepEqual(built.commands, {});
  });
}

for (const framework of ['android-java', 'swift', 'react-native', 'expo', 'uni-app']) {
  test(`${framework}: failed runtime cannot grant review or invoke packaging`, async t => {
    const platform = framework === 'swift' ? 'ios' : 'android';
    const f = fixture(t, framework, platform, platform === 'ios' ? 'ipa' : 'apk');
    const config = { ...f.config, verification: { ...f.config.verification, runtime: [[process.execPath, '-e', 'process.exit(17)']] } };
    const job = f.store.enqueue(f.spec, config);
    project(job.workspace, framework);
    f.store.update(job.id, { stage: 'verify' });
    const rejected = await runStep(f.store, config, job.id);
    assert.equal(rejected.stage, 'build');
    assert.equal(rejected.verifiedDigest, null);
    assert.equal(rejected.verifiedDependencyDigest, null);
    assert.equal(rejected.artifact ?? null, null);
    assert.equal(existsSync(f.packagingLog), false);
  });
}

for (const failure of ['missing', 'empty', 'source-mutation', 'dependency-mutation']) {
  test(`configured packaging cannot reuse stale output or evidence: ${failure}`, async t => {
    const f = fixture(t);
    const output = f.config.packaging.artifactPath;
    const script = failure === 'missing' ? '' : failure === 'empty' ? `require('node:fs').writeFileSync(${JSON.stringify(output)},'');` : `require('node:fs').writeFileSync(${JSON.stringify(output)},'new controlled output');require('node:fs').writeFileSync(${JSON.stringify(failure === 'source-mutation' ? 'model.json' : 'package-lock.json')},'{}');`;
    f.config.packaging.commands = [[process.execPath, '-e', `require('node:fs').mkdirSync('build',{recursive:true});${script}`]];
    const job = await approved(f);
    file(join(job.workspace, output), 'stale output must never count');
    const result = await runStep(f.store, f.config, job.id);
    assert.notEqual(result.status, 'built');
    assert.equal(result.artifact ?? null, null);
    assert.deepEqual(result.receipt, {});
    if (failure === 'missing') assert.equal(existsSync(join(job.workspace, output)), false);
    if (failure.endsWith('mutation')) assert.equal(result.verifiedDigest, null);
  });
}

test('an uncertain cloud packaging run retains reconciliation state and is never automatically replayed', async t => {
  const f = fixture(t);
  f.config.allowCloudBuild = true;
  f.config.packaging.provider = 'cloud';
  f.config.packaging.commands = [[process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(f.packagingLog)},'attempt\\n');process.exit(19);`]];
  const job = await approved(f);
  const blocked = await runStep(f.store, f.config, job.id);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.cloudBuildPending, true);
  const attempts = readFileSync(f.packagingLog, 'utf8');
  await executeStep(f.store, blocked);
  assert.equal(readFileSync(f.packagingLog, 'utf8'), attempts);
  assert.equal(f.store.get(job.id).artifact ?? null, null);
  const localConfig = { ...f.config, allowCloudBuild: false, packaging: { ...f.config.packaging, provider: 'local' } };
  const unrelated = f.store.enqueue({ ...f.spec, id: 'unrelated-local' }, localConfig);
  project(unrelated.workspace, f.spec.framework);
  f.store.update(unrelated.id, { stage: 'verify' });
  assert.equal((await runStep(f.store, localConfig, unrelated.id)).stage, 'review');
  assert.equal(f.store.get(job.id).cloudBuildPending, true);
  assert.equal(f.store.get(job.id).status, 'blocked');
});

test('an existing nested Expo project is snapshotted without ejection, shared files or edits to the original', async t => {
  const f = fixture(t);
  const source = join(f.root, 'existing');
  const directory = 'apps/mobile';
  project(join(source, directory), 'expo');
  file(join(source, 'packages/shared/value.js'), 'export const value = 1;\n');
  file(join(source, directory, 'node_modules/untrusted/cache.js'), 'generated dependency cache');
  file(join(source, directory, 'build/old.apk'), 'stale artifact');
  const pinned = sourceDigest(source, true, 'expo', directory);
  const job = f.store.enqueue({ ...f.spec, project: { sourceDir: source, directory } }, f.config);
  assert.equal(job.sourceDirectory, realpathSync(source));
  assert.equal(job.importDigest, pinned);
  const assessment = await nextTurn(f.store, job.id);
  assert.equal(assessment.turn.cwd, join(job.workspace, directory));
  assert.equal(f.store.get(job.id).importPrepared, true);
  assert.equal(existsSync(join(job.workspace, directory, 'node_modules')), false);
  assert.equal(existsSync(join(job.workspace, directory, 'build')), false);
  assert.equal(readFileSync(join(job.workspace, 'packages/shared/value.js'), 'utf8'), 'export const value = 1;\n');
  completeTurn(f.store, job.id, assessment.turn.id, research);
  const build = await nextTurn(f.store, job.id);
  assert.equal(existsSync(join(build.turn.cwd, 'ios')), false);
  assert.equal(existsSync(join(build.turn.cwd, 'android')), false);
  file(join(build.turn.cwd, 'index.js'), 'export const fixture = "edited snapshot";\n');
  completeTurn(f.store, job.id, build.turn.id);
  const verified = await runStep(f.store, f.config, job.id);
  assert.equal(verified.stage, 'review', verified.error);
  assert.equal(JSON.parse(readFileSync(f.runtimeLog)).cwd, join(job.workspace, directory));
  const review = await nextTurn(f.store, job.id);
  completeTurn(f.store, job.id, review.turn.id, reviewFor(review.job));
  const built = await runStep(f.store, f.config, job.id);
  assert.equal(built.status, 'built', built.error);
  assert.equal(built.artifact.path, join(job.workspace, directory, f.config.packaging.artifactPath));
  assert.equal(sourceDigest(source, true, 'expo', directory), pinned);
  assert.equal(readFileSync(join(source, directory, 'index.js'), 'utf8'), 'export const fixture = true;\n');
});

test('source changes after enqueue cannot silently replace an existing-project snapshot', async t => {
  const f = fixture(t);
  const source = join(f.root, 'existing');
  project(source, 'expo');
  const job = f.store.enqueue({ ...f.spec, project: { sourceDir: source } }, f.config);
  file(join(source, 'index.js'), 'changed after enqueue');
  const result = await nextTurn(f.store, job.id);
  assert.equal(result.job.status, 'blocked');
  assert.equal(result.turn, undefined);
  assert.equal(result.job.hostTurns, 0);
  assert.equal(existsSync(job.workspace), false);
});

test('existing-project intake rejects a source symlink escape without changing external files', t => {
  const f = fixture(t);
  const source = join(f.root, 'existing');
  project(source, 'expo');
  const outside = join(f.root, 'outside.js');
  writeFileSync(outside, 'owner data');
  symlinkSync(outside, join(source, 'linked.js'));
  assert.throws(() => f.store.enqueue({ ...f.spec, project: { sourceDir: source } }, f.config));
  assert.deepEqual(f.store.list(), []);
  assert.equal(readFileSync(outside, 'utf8'), 'owner data');
});

test('packaging rejects an internal output alias before deleting owned source or invoking commands', async t => {
  const f = fixture(t);
  const job = f.store.enqueue(f.spec, f.config);
  project(job.workspace, f.spec.framework);
  const owned = join(job.workspace, 'src/fixture.apk');
  file(owned, 'owned source bytes must survive');
  symlinkSync('src', join(job.workspace, 'build'), 'dir');
  const approved = f.store.update(job.id, { stage: 'package', status: 'running', verifiedDigest: sourceDigest(job.workspace, true, f.spec.framework), verifiedDependencyDigest: dependencyDigest(job.workspace, f.spec.framework), review: reviewFor(job) });
  const result = await executeStep(f.store, approved);
  assert.equal(result.status, 'blocked');
  assert.equal(readFileSync(owned, 'utf8'), 'owned source bytes must survive');
  assert.equal(existsSync(f.packagingLog), false);
  assert.equal(result.artifact ?? null, null);
});

for (const directory of ['build/mobile', 'feature/build/mobile']) {
  test(`selected project cannot acquire proof underneath generated output: ${directory}`, t => {
    const f = fixture(t);
    const source = join(f.root, 'generated-project');
    project(join(source, directory), 'expo');
    if (directory.startsWith('feature/')) {
      file(join(source, 'settings.gradle'), "include ':feature'\n");
      file(join(source, 'feature/build.gradle'), "plugins { id 'com.android.library' }\n");
    }
    const original = readFileSync(join(source, directory, 'model.json'), 'utf8');
    assert.throws(() => f.store.enqueue({ ...f.spec, project: { sourceDir: source, directory } }, f.config));
    assert.deepEqual(f.store.list(), []);
    assert.equal(readFileSync(join(source, directory, 'model.json'), 'utf8'), original);
  });
}

test('new projects cannot select a generated directory before a workspace is created', t => {
  const f = fixture(t);
  assert.throws(() => f.store.enqueue({ ...f.spec, project: { directory: 'build/mobile' } }, f.config));
  assert.deepEqual(f.store.list(), []);
});
