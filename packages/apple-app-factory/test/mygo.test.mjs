import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigSchema, SpecSchema, validateJobConfig } from '../dist/schemas.js';
import { validateMacOSArtifact } from '../dist/macos.js';
import { validateMyGoPackaging } from '../dist/mygo-build.js';
import { Store } from '../dist/store.js';
import { nextTurn, completeTurn } from '../dist/runner.js';
import { runStep } from '../dist/scheduler.js';
import { run } from '../dist/process.js';

const cli = resolve('dist/cli.js');
const product = { id: 'desktop-local', name: 'MyGo App', framework: 'mygo', platform: 'macos', channel: 'local', version: '0.1.0', purpose: 'Preserve a desktop workflow', audience: 'Mac owners', differentiators: ['Native local desktop behavior'], acceptance: ['Exercise the actual desktop workflow before packaging'] };
const argv = ['go', 'tool', 'mygo', 'build', '-platform', 'darwin/arm64', '-sign', '-', '-skip-notarize', '-skip-dmg', '-o', 'build'];
function fixture(t, patch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'apphx-mygo-'));
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'app', allowLocalExecution: true, verification: { checks: [[process.execPath, '--version']], runtime: [[process.execPath, '--version']] }, packaging: { provider: 'local', commands: [argv], artifactPath: 'build/darwin-arm64/MyGo App.app' }, ...patch });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, config };
}
function source(root) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'go.mod'), 'module example.com/desktop\ngo 1.27.1\nrequire github.com/egoist/mygo v0.3.0\ntool github.com/egoist/mygo/cmd/mygo\n');
  writeFileSync(join(root, 'mygo.json'), '{"name":"MyGo App","version":"0.1.0"}\n');
  writeFileSync(join(root, 'main.go'), 'package main\nfunc main() {}\n');
}

test('MyGo is a local macOS app/dmg contract, not a mobile or store-publishing shortcut', t => {
  const { config } = fixture(t);
  const spec = SpecSchema.parse(product);
  validateJobConfig(spec, config);
  validateJobConfig(spec, ConfigSchema.parse({ ...config, packageTarget: 'dmg', packaging: { ...config.packaging, commands: [argv.filter(value => value !== '-skip-dmg')], artifactPath: 'build/darwin-arm64/MyGo App 0.1.0.dmg' } }));
  for (const patch of [{ platform: 'ios' }, { platform: 'android' }, { framework: 'swift' }, { framework: 'flutter' }, { channel: 'app-store' }, { channel: 'google-play' }]) assert.throws(() => SpecSchema.parse({ ...product, ...patch }));
  for (const packageTarget of ['simulator', 'ipa', 'apk', 'aab']) assert.throws(() => validateJobConfig(spec, ConfigSchema.parse({ ...config, packageTarget })));
  assert.throws(() => validateJobConfig(spec, ConfigSchema.parse({ ...config, allowCloudBuild: true })));
});

test('MyGo direct build rejects unrequested publishing, credentials, ambiguous flags and source outputs', t => {
  const { config } = fixture(t);
  validateMyGoPackaging(config);
  const commands = [
    [...argv, '-upload'], [...argv, '-upload=false'], [...argv, '-skip-notarize=false'],
    argv.filter(value => value !== '-skip-notarize'),
    argv.map((value, index) => index === argv.indexOf('-sign') + 1 ? 'Developer ID Application: Not Authorized' : value),
    [...argv, '-sign', '-'], [...argv, '--skip-notarize'],
    argv.map(value => value === 'darwin/arm64' ? 'windows/amd64' : value),
    argv.map(value => value === 'darwin/arm64' ? 'darwin/arm64,darwin/amd64' : value),
    [...argv.slice(0, -1), '../source'], ['npm', 'run', 'build'],
    ['go', 'run', 'github.com/egoist/mygo/cmd/mygo@latest', ...argv.slice(3)],
  ];
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  for (const command of commands) {
    const invalid = { ...config, packaging: { ...config.packaging, commands: [command] } };
    assert.throws(() => validateMyGoPackaging(invalid));
    assert.throws(() => store.enqueue(product, invalid));
    assert.deepEqual(store.list(), []);
  }
  assert.throws(() => validateMyGoPackaging({ ...config, packaging: { ...config.packaging, commands: [argv, argv] } }));
  assert.throws(() => validateMyGoPackaging({ ...config, packaging: { ...config.packaging, artifactPath: 'build/darwin-amd64/MyGo App.app' } }));
  assert.throws(() => validateMyGoPackaging({ ...config, packageTarget: 'dmg' }));
  validateMyGoPackaging({ ...config, packageTarget: 'dmg', packaging: { ...config.packaging, commands: [argv.filter(value => value !== '-skip-dmg')], artifactPath: 'build/darwin-arm64/MyGo App 0.1.0.dmg' } });
});

for (const target of ['app', 'dmg']) test(`actual CLI initializes a MyGo ${target} without granting execution or publication`, async t => {
  const { root } = fixture(t);
  const configPath = join(root, 'factory.json');
  const result = await run([process.execPath, cli, 'init', '--framework', 'mygo', '--package-target', target, '--config', configPath]);
  assert.equal(result.code, 0, result.stderr);
  const created = JSON.parse(readFileSync(configPath, 'utf8'));
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.platform, 'macos');
  assert.equal(created.packageTarget, target);
  for (const permission of ['allowLocalExecution', 'allowCloudBuild']) assert.equal(created[permission], false);
  validateMyGoPackaging(ConfigSchema.parse({ ...created, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces') }));
  assert.equal((await run([process.execPath, cli, 'init', '--framework', 'mygo', '--config', configPath])).code, 1);
  assert.equal(readFileSync(configPath, 'utf8'), JSON.stringify(created, null, 2) + '\n');
});

for (const [framework, platform, target] of [['mygo', 'ios', 'ipa'], ['mygo', 'android', 'apk'], ['swift', 'macos', 'app'], ['flutter', 'macos', 'app'], ['mygo', 'macos', 'ipa']]) test(`init rejects unsupported ${framework}/${platform}/${target} before writing`, async t => {
  const { root } = fixture(t);
  const path = join(root, 'absent-control', 'factory.json');
  const result = await run([process.execPath, cli, 'init', '--framework', framework, '--platform', platform, '--package-target', target, '--config', path]);
  assert.notEqual(result.code, 0);
  assert.throws(() => readFileSync(path));
});

test('failed actual desktop acceptance never grants review or dispatches the MyGo packager', async t => {
  const { config } = fixture(t, { verification: { checks: [[process.execPath, '--version']], runtime: [[process.execPath, '-e', 'process.exit(17)']] } });
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  const job = store.enqueue(product, config);
  source(job.workspace);
  store.update(job.id, { stage: 'verify' });
  const result = await runStep(store, config, job.id);
  assert.equal(result.stage, 'verify');
  assert.equal(result.status, 'waiting');
  assert.equal(result.recoveryStage, 'verify');
  assert.equal(result.verifiedDigest, null);
  assert.equal(result.verifiedDependencyDigest, null);
  assert.equal(result.artifact ?? null, null);
  assert.equal(result.attempts.package, undefined);
});

test('native MyGo host completion preserves Go-only source without inventing frontend files', async t => {
  const { config } = fixture(t);
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  const job = store.enqueue(product, config);
  const research = await nextTurn(store, job.id);
  completeTurn(store, job.id, research.turn.id, { viable: true, distinctness: 'A local native desktop task, not store eligibility.', plan: ['Implement and exercise the actual native window'] });
  const build = await nextTurn(store, job.id);
  source(build.turn.cwd);
  assert.equal(build.turn.environment.GOWORK, 'off');
  assert.equal(build.turn.environment.GOENV, 'off');
  assert.equal(completeTurn(store, job.id, build.turn.id).stage, 'verify');
  assert.throws(() => readFileSync(join(job.workspace, 'package.json')));
});

test('a named app folder containing a script is not a valid macOS application', { skip: process.platform !== 'darwin' }, async t => {
  const { root } = fixture(t);
  const app = join(root, 'Invalid.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Invalid</string></dict></plist>');
  writeFileSync(join(app, 'Contents/MacOS/Invalid'), '#!/bin/sh\necho not-a-native-app\n');
  chmodSync(join(app, 'Contents/MacOS/Invalid'), 0o700);
  await assert.rejects(validateMacOSArtifact(app, 'app', run));
});

test('runtime screenshots cannot be placed in or around the replaced MyGo platform output', t => {
  const { config } = fixture(t);
  for (const screenshotsDir of ['build/darwin-arm64/screenshots', 'build/darwin-arm64', 'build', '.', '/tmp/shots', '../shots']) assert.throws(() => validateJobConfig(SpecSchema.parse({ ...product, screenshotsDir }), config));
  validateJobConfig(SpecSchema.parse({ ...product, screenshotsDir: 'build/screenshots' }), config);
});

test('an unversioned direct go run MyGo build cannot bypass local flags during verification', async t => {
  const { config } = fixture(t, { verification: { checks: [['go', 'run', 'github.com/egoist/mygo/cmd/mygo', 'build', '-upload']], runtime: [[process.execPath, '--version']] } });
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  const job = store.enqueue(product, config);
  source(job.workspace);
  store.update(job.id, { stage: 'verify' });
  const result = await runStep(store, config, job.id);
  assert.equal(result.status, 'blocked');
  assert.equal(result.verifiedDigest ?? null, null);
  assert.equal(result.artifact ?? null, null);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.commands, {});
});
