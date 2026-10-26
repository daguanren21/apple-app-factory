import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dependencyDigest } from '../dist/dependencies.js';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { executeStep, nextTurn, sourceDigest } from '../dist/runner.js';

function file(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fixture(t, verification) {
  const root = mkdtempSync(join(tmpdir(), 'factory-dependency-proof-'));
  const noop = [process.execPath, '-e', 'process.exit(0)'];
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), allowLocalExecution: true,
    verification: verification ?? { checks: [noop], runtime: [noop] } });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const spec = { id: 'dependency-proof', name: 'Dependency proof', purpose: 'Keep effective dependency resolution verified', audience: 'Owners', framework: 'flutter', differentiators: ['Resolution proof'], acceptance: ['Reject changed dependency resolution'], apple: { version: '1.0.0' } };
  const job = store.enqueue(spec, config);
  file(join(job.workspace, 'pubspec.yaml'), 'name: app\ndependencies:\n  hosted_package: any\n  flutter: {sdk: flutter}\n  git_package: {git: https://example.invalid/package}\n');
  file(join(job.workspace, 'pubspec.lock'), 'packages:\n  hosted_package: {source: hosted, version: "1.0.0"}\n  flutter: {source: sdk, version: "1.0.0"}\n  git_package: {source: git, version: "1.0.0"}\n');
  const path = join(job.workspace, '.dart_tool', 'package_config.json');
  const metadata = { configVersion: 2, generated: '2020-01-01T00:00:00Z', generator: 'pub', generatorVersion: 'fixture', packages: ['hosted_package', 'flutter', 'git_package'].map(name => {
    const packageRoot = join(root, 'trusted', name);
    mkdirSync(join(packageRoot, 'lib'), { recursive: true });
    return { name, rootUri: `${pathToFileURL(packageRoot).href}/`, packageUri: 'lib/', languageVersion: '3.6' };
  }) };
  file(path, JSON.stringify(metadata));
  return { root, config, store, spec, job, path, metadata, save() { file(path, JSON.stringify(metadata)); } };
}

for (const name of ['hosted_package', 'flutter', 'git_package']) {
  for (const field of ['rootUri', 'packageUri']) {
    test(`${name} ${field} redirection changes the dependency proof but not source ownership`, t => {
      const f = fixture(t);
      const source = sourceDigest(f.job.workspace);
      const before = dependencyDigest(f.job.workspace);
      const entry = f.metadata.packages.find(value => value.name === name);
      entry[field] = `${pathToFileURL(join(f.root, 'replacement')).href}/`;
      f.save();
      assert.equal(sourceDigest(f.job.workspace), source);
      assert.notEqual(dependencyDigest(f.job.workspace), before);
    });
  }
}

test('generator timestamps, package order and equivalent resolved URIs do not invalidate the proof', t => {
  const f = fixture(t);
  const before = dependencyDigest(f.job.workspace);
  f.metadata.generated = '2030-12-31T23:59:59Z';
  f.metadata.generatorVersion = 'another-generator-version';
  f.metadata.packages.reverse();
  for (const entry of f.metadata.packages) {
    entry.rootUri = relative(dirname(f.path), join(f.root, 'trusted', entry.name));
    entry.packageUri = './lib';
  }
  f.save();
  assert.equal(dependencyDigest(f.job.workspace), before);
});

test('config version and language version are part of the effective proof', t => {
  const f = fixture(t);
  const before = dependencyDigest(f.job.workspace);
  f.metadata.configVersion = 3;
  f.save();
  assert.notEqual(dependencyDigest(f.job.workspace), before);
  f.metadata.configVersion = 2;
  f.metadata.packages[0].languageVersion = '3.7';
  f.save();
  assert.notEqual(dependencyDigest(f.job.workspace), before);
});

test('missing and newly added package configuration are explicit distinct proof states', t => {
  const f = fixture(t);
  const before = dependencyDigest(f.job.workspace);
  const source = sourceDigest(f.job.workspace);
  rmSync(f.path);
  const missing = dependencyDigest(f.job.workspace);
  assert.match(missing, /^[a-f0-9]{64}$/);
  assert.notEqual(missing, before);
  assert.equal(sourceDigest(f.job.workspace), source);
  file(f.path, JSON.stringify({ configVersion: 2, packages: [] }));
  assert.notEqual(dependencyDigest(f.job.workspace), missing);
  f.save();
  assert.equal(dependencyDigest(f.job.workspace), before);
});

test('verification captures effective dependency proof alongside source proof', async t => {
  const f = fixture(t);
  const expected = dependencyDigest(f.job.workspace);
  const result = await executeStep(f.store, f.store.update(f.job.id, { stage: 'verify', status: 'running' }));
  assert.equal(result.stage, 'review');
  assert.equal(result.verifiedDependencyDigest, expected);
});

test('dependency redirection during verification cannot produce approved proof', async t => {
  const script = "const fs=require('node:fs'); const p='.dart_tool/package_config.json'; const config=JSON.parse(fs.readFileSync(p)); config.packages[0].packageUri='redirected/'; fs.writeFileSync(p,JSON.stringify(config));";
  const f = fixture(t, { checks: [[process.execPath, '-e', script]], runtime: [[process.execPath, '-e', 'process.exit(0)']] });
  const source = sourceDigest(f.job.workspace);
  const result = await executeStep(f.store, f.store.update(f.job.id, { stage: 'verify', status: 'running' }));
  assert.equal(sourceDigest(f.job.workspace), source);
  assert.equal(result.stage, 'build');
  assert.match(result.error, /dependenc|resolution/i);
  assert.equal(result.verifiedDependencyDigest, null);
});

for (const stage of ['review', 'package']) {
  for (const name of ['hosted_package', 'flutter', 'git_package']) {
    for (const field of ['rootUri', 'packageUri']) {
      test(`${stage} rejects ${name} ${field} redirection before granting a host turn or invoking a compiler`, async t => {
        const f = fixture(t);
        const verifiedDigest = sourceDigest(f.job.workspace);
        const verifiedDependencyDigest = dependencyDigest(f.job.workspace);
        f.metadata.packages.find(value => value.name === name)[field] = `${pathToFileURL(join(f.root, 'replacement')).href}/`;
        f.save();
        const queued = f.store.update(f.job.id, { stage, status: 'queued', verifiedDigest, verifiedDependencyDigest });
        const result = stage === 'review' ? (await nextTurn(f.store, queued.id)).job : await executeStep(f.store, queued);
        assert.match(result.error, /dependenc|resolution/i);
        assert.equal(result.hostTurns, 0);
        assert.equal(existsSync(join(f.job.workspace, 'build')), false);
      });
    }
  }
  test(`${stage} requires re-verification for legacy source-only proof`, async t => {
    const f = fixture(t);
    const queued = f.store.update(f.job.id, { stage, status: 'queued', verifiedDigest: sourceDigest(f.job.workspace) });
    const result = stage === 'review' ? (await nextTurn(f.store, queued.id)).job : await executeStep(f.store, queued);
    assert.match(result.error, /dependenc|resolution/i);
    assert.equal(result.hostTurns, 0);
  });
}

test('successor source copying does not require or inherit generated dependency proof', async t => {
  const failure = [process.execPath, '-e', 'process.exit(1)'];
  const f = fixture(t, { prerequisites: [failure], checks: [['unused']], runtime: [['unused']] });
  file(join(f.job.workspace, 'packages', 'owned', 'pubspec.yaml'), 'name: owned\n');
  file(join(f.job.workspace, 'packages', 'owned', 'lib', 'value.dart'), 'int value = 1;\n');
  file(join(f.job.workspace, 'pubspec.yaml'), `${readFileSync(join(f.job.workspace, 'pubspec.yaml'), 'utf8')}  owned: {path: packages/owned}\n`);
  const source = sourceDigest(f.job.workspace);
  const dependencies = dependencyDigest(f.job.workspace);
  f.store.update(f.job.id, { status: 'built', stage: 'package', verifiedDigest: source, verifiedDependencyDigest: dependencies });
  const successor = f.store.enqueue({ ...f.spec, apple: { version: '1.1.0' } }, f.config, f.job.id);
  const result = await executeStep(f.store, f.store.update(successor.id, { stage: 'verify', status: 'running' }));
  assert.equal(result.basePrepared, true);
  assert.equal(result.blockedReason.kind, 'prerequisite');
  assert.equal(sourceDigest(result.workspace), source);
  assert.equal(readFileSync(join(result.workspace, 'packages', 'owned', 'lib', 'value.dart'), 'utf8'), 'int value = 1;\n');
  assert.equal(existsSync(join(result.workspace, '.dart_tool')), false);
  assert.notEqual(dependencyDigest(result.workspace), dependencies);
  assert.equal(result.verifiedDependencyDigest, undefined);
});

for (const declaration of ['manifest', 'lock']) {
  test(`an owned absolute local ${declaration} path is rejected before source proof`, t => {
    const f = fixture(t);
    const owned = join(f.job.workspace, 'packages', 'owned');
    file(join(owned, 'pubspec.yaml'), 'name: owned\n');
    file(join(owned, 'lib', 'value.dart'), 'int value = 1;\n');
    if (declaration === 'manifest') file(join(f.job.workspace, 'pubspec.yaml'), `name: app\ndependencies:\n  owned: {path: ${JSON.stringify(owned)}}\n`);
    else file(join(f.job.workspace, 'pubspec.lock'), `packages:\n  owned:\n    source: path\n    description: {path: ${JSON.stringify(owned)}, relative: false}\n`);
    assert.throws(() => sourceDigest(f.job.workspace), /workspace-relative path/);
  });
}
