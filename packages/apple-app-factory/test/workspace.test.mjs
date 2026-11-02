import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ConfigSchema } from '../dist/contracts/schemas.js';
import { Store } from '../dist/state/store.js';
import { executeStep } from '../dist/workflow/runner.js';
import { assertProjectSnapshot, hostProjectDirectory, prepareExecutionWorkspace, prepareWorkspace, projectDirectory, sourceDigest, sourceProjectDirectory } from '../dist/projects/workspace.js';
import { dependencyDigest } from '../dist/projects/dependencies.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-successor-'));
  const config = ConfigSchema.parse({ projectMode: 'isolated', projectRoot: join(root, 'workspaces'), stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator', allowLocalExecution: true,
    verification: { prerequisites: [[process.execPath, '-e', "process.stderr.write('Fixture environment unavailable'); process.exit(1)"]], checks: [['unused']], runtime: [['unused']] } });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const spec = { id: 'revision-product', name: 'Revision product', purpose: 'Preserve local revision data', audience: 'Revision consumers', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Verified source continuation'], acceptance: ['Retain existing behavior'] };
  const base = store.enqueue(spec, config);
  mkdirSync(join(base.workspace, 'lib'), { recursive: true });
  mkdirSync(join(base.workspace, 'build'), { recursive: true });
  writeFileSync(join(base.workspace, 'lib', 'model.dart'), 'int total(int a, int b) => a + b;\n');
  writeFileSync(join(base.workspace, 'build', 'stale-artifact'), 'must not be copied');
  store.update(base.id, { status: 'built', stage: 'package', verifiedDigest: sourceDigest(base.workspace), verifiedDependencyDigest: dependencyDigest(base.workspace, spec.framework) });
  const successor = store.enqueue({ ...spec, version: '1.1.0', acceptance: ['Retain existing behavior', 'Handle the next requirement'] }, config, base.id);
  return { store, base: store.get(base.id), successor };
}

test('a new requirement copies verified predecessor source without sharing files or stale artifacts', async t => {
  const { store, base, successor } = fixture(t);
  store.update(successor.id, { stage: 'verify' });
  const result = await executeStep(store, store.next());
  assert.equal(result.status, 'blocked');
  assert.equal(result.blockedReason.kind, 'prerequisite');
  assert.equal(result.basePrepared, true);
  assert.equal(sourceDigest(result.workspace), base.verifiedDigest);
  assert.equal(existsSync(join(result.workspace, 'build', 'stale-artifact')), false);
  writeFileSync(join(result.workspace, 'lib', 'model.dart'), 'int total(int a, int b) => a - b;\n');
  assert.equal(readFileSync(join(base.workspace, 'lib', 'model.dart'), 'utf8'), 'int total(int a, int b) => a + b;\n');
  const retried = await executeStep(store, store.update(result.id, { status: 'running' }));
  assert.equal(retried.status, 'blocked');
  assert.equal(readFileSync(join(result.workspace, 'lib', 'model.dart'), 'utf8'), 'int total(int a, int b) => a - b;\n');
});

test('changed predecessor code is not silently copied as verified source', async t => {
  const { store, base, successor } = fixture(t);
  writeFileSync(join(base.workspace, 'lib', 'model.dart'), 'changed after intake');
  store.update(successor.id, { stage: 'verify' });
  const result = await executeStep(store, store.next());
  assert.equal(result.status, 'blocked');
  assert.equal(existsSync(successor.workspace), false);
  assert.equal(result.hostTurns, 0);
});

test('a crash between atomic copy and checkpoint safely resumes without overwriting divergent work', async t => {
  const { store, base, successor } = fixture(t);
  mkdirSync(join(successor.workspace, 'lib'), { recursive: true });
  writeFileSync(join(successor.workspace, 'lib', 'model.dart'), readFileSync(join(base.workspace, 'lib', 'model.dart')));
  store.update(successor.id, { stage: 'verify' });
  const result = await executeStep(store, store.next());
  assert.equal(result.basePrepared, true);
  assert.equal(result.blockedReason.kind, 'prerequisite');
  store.update(successor.id, { basePrepared: false, status: 'queued', nextAt: 0 });
  writeFileSync(join(successor.workspace, 'lib', 'model.dart'), 'user work after interrupted preparation');
  const divergent = await executeStep(store, store.next());
  assert.equal(divergent.status, 'blocked');
  assert.equal(readFileSync(join(successor.workspace, 'lib', 'model.dart'), 'utf8'), 'user work after interrupted preparation');
});

test('project mode separates live and execution paths and relocates owned generated dependency inputs', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-project-snapshot-')));
  const project = join(root, 'project');
  const state = join(root, 'state');
  const workspaces = join(root, 'workspaces');
  mkdirSync(join(project, 'lib'), { recursive: true });
  mkdirSync(join(project, '.dart_tool'), { recursive: true });
  mkdirSync(join(project, 'build'));
  writeFileSync(join(project, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(project, 'lib', 'main.dart'), 'void main() {}\n');
  writeFileSync(join(project, 'build', 'runtime-input'), 'runtime\n');
  writeFileSync(join(project, '.dart_tool', 'package_config.json'), JSON.stringify({ configVersion: 2, packages: [{ name: 'app', rootUri: `${pathToFileURL(project).href}/`, packageUri: `${pathToFileURL(join(project, 'lib')).href}/` }] }));
  symlinkSync(join(project, 'lib', 'main.dart'), join(project, '.dart_tool', 'owned-source'));
  const config = ConfigSchema.parse({ projectMode: 'project', projectRoot: project, stateDir: state, workspaceRoot: workspaces, packageTarget: 'simulator', allowLocalExecution: true, verification: { checks: [['unused']], runtime: [['unused']] } });
  const spec = { id: 'project-snapshot', name: 'Project snapshot', purpose: 'Relocate owned runtime inputs', audience: 'Owners', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Live source'], acceptance: ['Snapshot stays isolated'] };
  const store = new Store(config.stateDir);
  const job = store.enqueue(spec, { ...config, obfuscation: { options: {} } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const source = sourceDigest(project, true, spec.framework);
  const dependencies = dependencyDigest(project, spec.framework);
  const paths = { source: sourceProjectDirectory(job), execution: projectDirectory(job), host: hostProjectDirectory({ ...job, stage: 'review' }) };
  assert.equal(paths.source, project);
  assert.equal(paths.execution, job.workspace);
  assert.equal(paths.host, job.workspace);
  assert.deepEqual(prepareWorkspace(store, job), undefined);
  const patch = prepareExecutionWorkspace(store, job);
  assert.equal(patch.projectDigest, source);
  assert.equal(patch.projectDependencyDigest, dependencies);
  assert.equal(readFileSync(join(project, 'lib', 'main.dart'), 'utf8'), 'void main() {}\n');
  assert.equal(readFileSync(join(job.workspace, 'build', 'runtime-input'), 'utf8'), 'runtime\n');
  const copiedConfig = join(job.workspace, '.dart_tool', 'package_config.json');
  const copied = JSON.parse(readFileSync(copiedConfig));
  const copiedRoot = new URL(copied.packages[0].rootUri, pathToFileURL(copiedConfig));
  const copiedPackage = fileURLToPath(new URL(copied.packages[0].packageUri, copiedRoot));
  assert.equal(realpathSync(fileURLToPath(copiedRoot)), realpathSync(job.workspace));
  assert.equal(readFileSync(join(copiedPackage, 'main.dart'), 'utf8'), 'void main() {}\n');
  writeFileSync(join(project, 'lib', 'main.dart'), 'void main() => print("changed");\n');
  assert.throws(() => assertProjectSnapshot({ ...job, ...patch }), error => error.code === 'EVIDENCE_CHANGED');
  assert.equal(readFileSync(join(copiedPackage, 'main.dart'), 'utf8'), 'void main() {}\n');
  assert.equal(readFileSync(join(job.workspace, '.dart_tool', 'owned-source'), 'utf8'), 'void main() {}\n');
});

test('execution snapshots reject unsafe generated dependency links before touching the live project', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-project-unsafe-link-')));
  const project = join(root, 'project');
  mkdirSync(join(project, '.dart_tool'), { recursive: true });
  mkdirSync(join(project, 'lib'));
  writeFileSync(join(project, 'pubspec.yaml'), 'name: app\ndependencies:\n  flutter: {sdk: flutter}\n');
  writeFileSync(join(project, 'lib', 'main.dart'), 'void main() {}\n');
  const outside = join(root, 'outside');
  writeFileSync(outside, 'not owned');
  symlinkSync(outside, join(project, '.dart_tool', 'unsafe'));
  const config = ConfigSchema.parse({ projectMode: 'project', projectRoot: project, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator', allowLocalExecution: true, verification: { checks: [['unused']], runtime: [['unused']] } });
  const store = new Store(config.stateDir);
  const job = store.enqueue({ id: 'unsafe-link', name: 'Unsafe link', purpose: 'Reject unsafe links', audience: 'Owners', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Link'], acceptance: ['Reject'] }, { ...config, obfuscation: { options: {} } });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.throws(() => prepareExecutionWorkspace(store, job), error => error.code === 'EVIDENCE_CHANGED');
  assert.equal(existsSync(job.workspace), false);
  assert.equal(readFileSync(join(project, 'lib', 'main.dart'), 'utf8'), 'void main() {}\n');
});

test('an explicitly selected old workspace child snapshots into a disjoint sibling', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-sibling-snapshot-')));
  const workspaceRoot = join(root, 'workspaces');
  const projectRoot = join(workspaceRoot, 'old-job');
  mkdirSync(join(projectRoot, 'lib'), { recursive: true });
  mkdirSync(join(projectRoot, '.dart_tool'));
  writeFileSync(join(projectRoot, 'pubspec.yaml'), 'name: sibling_app\n');
  writeFileSync(join(projectRoot, 'lib/main.dart'), 'void main() {}\n');
  symlinkSync(join(projectRoot, 'lib/main.dart'), join(projectRoot, '.dart_tool/owned-source'));
  const config = ConfigSchema.parse({ projectRoot, workspaceRoot, stateDir: join(root, 'state'), packageTarget: 'simulator', obfuscation: { options: {} }, verification: { checks: [['unused']], runtime: [['unused']] } });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue({ id: 'sibling-snapshot', name: 'Sibling snapshot', purpose: 'Retain explicitly selected source', audience: 'Owners', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Selected source'], acceptance: ['Copy to a disjoint sibling'] }, config);
  const before = sourceDigest(projectRoot, true, 'flutter');
  const patch = prepareExecutionWorkspace(store, job);
  assert.equal(job.projectRoot, projectRoot);
  assert.equal(job.workspace, join(workspaceRoot, job.id));
  assert.equal(patch.projectDigest, before);
  assert.equal(sourceDigest(job.workspace, true, 'flutter'), before);
  assert.equal(readFileSync(join(job.workspace, '.dart_tool/owned-source'), 'utf8'), 'void main() {}\n');
  writeFileSync(join(job.workspace, 'lib/main.dart'), 'transformed copy');
  assert.equal(readFileSync(join(projectRoot, 'lib/main.dart'), 'utf8'), 'void main() {}\n');
  const outside = join(root, 'not-owned');
  writeFileSync(outside, 'outside bytes');
  symlinkSync(outside, join(projectRoot, '.dart_tool/escape'));
  assert.throws(() => prepareExecutionWorkspace(store, job), /Unsafe source symlink/);
  assert.equal(readFileSync(join(job.workspace, 'lib/main.dart'), 'utf8'), 'transformed copy');
});

test('nested Git and control metadata share proof and copy exclusions without hiding ordinary source', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'factory-nested-metadata-')));
  const projectRoot = join(root, 'project');
  for (const directory of ['vendor/checkout/.git', 'vendor/submodule', 'vendor/checkout/.factory-input', 'lib/build', 'native/Pods', 'native/.build']) mkdirSync(join(projectRoot, directory), { recursive: true });
  const metadata = ['vendor/checkout/.git/config', 'vendor/submodule/.git', 'vendor/checkout/.factory-input/request.json'];
  const source = ['vendor/checkout/library.dart', 'vendor/submodule/library.dart', 'lib/build/value.dart', 'native/Pods/owned.swift', 'native/.build/owned.swift'];
  for (const path of metadata) writeFileSync(join(projectRoot, path), 'metadata before');
  for (const path of source) writeFileSync(join(projectRoot, path), `owned ${path}`);
  const config = ConfigSchema.parse({ projectRoot, workspaceRoot: join(root, 'workspaces'), stateDir: join(root, 'state'), packageTarget: 'simulator', obfuscation: { options: {} }, verification: { checks: [['unused']], runtime: [['unused']] } });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue({ id: 'nested-metadata', name: 'Nested metadata', purpose: 'Keep metadata exclusions consistent', audience: 'Owners', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0', differentiators: ['Source proof'], acceptance: ['Keep ordinary source'] }, config);
  const before = sourceDigest(projectRoot, true, 'flutter');
  for (const path of metadata) writeFileSync(join(projectRoot, path), 'metadata after');
  assert.equal(sourceDigest(projectRoot, true, 'flutter'), before);
  const patch = prepareExecutionWorkspace(store, job);
  assert.equal(patch.projectDigest, before);
  assert.equal(sourceDigest(job.workspace, true, 'flutter'), before);
  for (const path of metadata) assert.equal(existsSync(join(job.workspace, path)), false, path);
  for (const path of source) {
    const original = readFileSync(join(projectRoot, path), 'utf8');
    assert.equal(readFileSync(join(job.workspace, path), 'utf8'), original);
    writeFileSync(join(projectRoot, path), 'changed owned bytes');
    assert.notEqual(sourceDigest(projectRoot, true, 'flutter'), before, path);
    writeFileSync(join(projectRoot, path), original);
  }
});
