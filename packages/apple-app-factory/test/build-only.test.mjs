import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { Store } from '../dist/store.js';
import { executeStep } from '../dist/runner.js';
import { sourceDigest } from '../dist/workspace.js';
import { dependencyDigest } from '../dist/dependencies.js';
import { run } from '../dist/process.js';
import { remoteCommand } from '../dist/remote.js';
import { setTimeout as sleep } from 'node:timers/promises';

const example = JSON.parse(readFileSync(new URL('../examples/factory.json', import.meta.url)));
const product = JSON.parse(readFileSync(new URL('../examples/luggage.json', import.meta.url)));
const cli = resolve('dist/cli.js');

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-build-only-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, "worker ' ; configuration.json");
  writeFileSync(configPath, JSON.stringify({ ...example, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), allowLocalExecution: true, verification: { prerequisites: [], checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] }, ...overrides }));
  return { root, configPath, config: loadConfig(configPath) };
}

for (const mode of ['artifact', 'missing', 'mutated-source']) {
  test(`build-only packaging requires a fresh artifact and unchanged verified source: ${mode}`, { skip: process.platform !== 'darwin' }, async t => {
    const f = fixture(t);
    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    // A controlled compiler-process fixture, not an actual Flutter or iOS build.
    writeFileSync(join(bin, 'flutter'), `#!${process.execPath}\nimport {mkdirSync,writeFileSync} from 'node:fs';\n${mode === 'missing' ? '' : "mkdirSync('build/ios/iphonesimulator/Runner.app',{recursive:true});writeFileSync('build/ios/iphonesimulator/Runner.app/Runner','controlled compiler output');"}\n${mode === 'mutated-source' ? "writeFileSync('model.dart','unverified mutation');" : ''}\n`, { mode: 0o700 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
    t.mock.method(globalThis, 'fetch', () => { throw new Error('Build-only must not contact Apple'); });
    const store = new Store(f.config.stateDir);
    t.after(() => store.close());
    const spec = structuredClone(product);
    delete spec.screenshotsDir;
    spec.channel = 'local';
    const job = store.enqueue(spec, f.config);
    mkdirSync(join(job.workspace, 'build', 'ios', 'iphonesimulator', 'Stale.app'), { recursive: true });
    writeFileSync(join(job.workspace, 'build', 'ios', 'iphonesimulator', 'Stale.app', 'Runner'), 'old output');
    writeFileSync(join(job.workspace, 'model.dart'), 'verified source');
    const digest = sourceDigest(job.workspace);
    const result = await executeStep(store, store.update(job.id, { stage: 'package', verifiedDigest: digest, verifiedDependencyDigest: dependencyDigest(job.workspace), review: { approved: true, findings: [], acceptanceEvidence: spec.acceptance.map(requirement => ({ requirement, evidence: 'Controlled packaging fixture' })) } }));
    assert.equal(existsSync(join(job.workspace, 'build', 'ios', 'iphonesimulator', 'Stale.app')), false);
    assert.deepEqual(result.receipt, {});
    assert.equal(result.hostTurns, 0);
    if (mode === 'artifact') {
      assert.equal(result.status, 'built');
      assert.equal(result.stage, 'package');
      assert.equal(result.artifact.kind, 'ios-simulator');
      assert.equal(readFileSync(join(result.artifact.path, 'Runner'), 'utf8'), 'controlled compiler output');
      assert.equal(result.artifact.digest, sourceDigest(result.artifact.path, false));
      assert.equal(store.next(), undefined);
      assert.equal(store.get(job.id).artifact.digest, result.artifact.digest);
    } else {
      assert.notEqual(result.status, 'built');
      assert.equal(result.artifact, null);
    }
  });
}

test('build-only CLI rejects removed publication permissions in configuration before creating a queue', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factory-build-only-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'factory.json');
  // Written raw: loadConfig is strict and must be the thing that rejects the legacy keys.
  writeFileSync(configPath, JSON.stringify({ ...example, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), allowLocalExecution: true, verification: { prerequisites: [], checks: [[process.execPath, '-e', 'process.exit(0)']], runtime: [[process.execPath, '-e', 'process.exit(0)']] }, allowSubmit: true, allowRelease: false }));
  const result = await run([process.execPath, cli, 'enqueue', '-', '--build-only', '--config', configPath], { input: JSON.stringify(product) });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /allowSubmit/);
  assert.equal(existsSync(join(root, 'state')), false);
  assert.equal(existsSync(join(root, 'workspaces')), false);
});

test('build-only step refuses host-stage queued work without claiming it', async t => {
  const f = fixture(t);
  const store = new Store(f.config.stateDir);
  t.after(() => store.close());
  const job = store.enqueue(product, f.config);
  assert.equal(job.stage, 'research');
  const before = store.get(job.id);
  const result = await run([process.execPath, cli, 'step', job.id, '--build-only', '--config', f.configPath]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /belongs to the host/);
  assert.equal(store.get(job.id).status, 'queued');
  assert.equal(store.get(job.id).hostTurns, 0);
  assert.deepEqual(store.get(job.id), before);
  assert.deepEqual(store.db.prepare('SELECT * FROM worker').all(), []);
});

test('remote command transports validated local requirements through stdin without shell interpretation', async t => {
  const f = fixture(t);
  const spec = { ...product, name: "Trip '; touch should-not-run; '" };
  const specPath = join(f.root, 'local product.json');
  writeFileSync(specPath, JSON.stringify(spec));
  const executable = join(f.root, "apphx ' ; launcher");
  writeFileSync(executable, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const result=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},...process.argv.slice(2)],{stdio:'inherit'});if(result.error)throw result.error;process.exit(result.status??1);\n`, { mode: 0o700 });
  const command = remoteCommand({ host: 'mac-mini', directory: resolve('.'), executable, config: f.configPath }, ['enqueue', specPath]);
  // Exercise the remote POSIX command locally; SSH authentication/transport is not simulated as connected.
  const result = await run(['/bin/sh', '-c', command.argv.at(-1)], { input: command.input });
  assert.equal(result.code, 0, result.stderr);
  const store = new Store(f.config.stateDir);
  t.after(() => store.close());
  const saved = store.get(JSON.parse(result.stdout).id);
  assert.equal(saved.spec.name, spec.name);
  assert.equal(saved.config.allowLocalExecution, true);
  assert.equal(saved.config.packageTarget, 'simulator');
  assert.ok(!('allowSubmit' in saved.config) && !('allowRelease' in saved.config));
  assert.equal(saved.stage, 'research');
  assert.equal(existsSync('should-not-run'), false);
});

test('remote dispatch rejects publication actions and SSH option injection', () => {
  const remote = { host: 'mac-mini', directory: '/srv/factory', executable: '/usr/local/bin/apphx', config: '/srv/factory/factory.json' };
  for (const action of ['authorize', 'feedback', 'publish', 'run', 'service', 'worker', 'stop']) assert.throws(() => remoteCommand(remote, [action]));
  for (const host of ['-oProxyCommand=touch injected', 'worker;touch injected', 'worker\nmalicious']) assert.throws(() => remoteCommand({ ...remote, host }, ['status']));
});

for (const failure of ['missing-output', 'compiler-failure', 'interrupted']) {
  test(`replacing an artifact invalidates its evidence even when rebuilding is ${failure}`, { skip: process.platform !== 'darwin', timeout: 10000 }, async t => {
    const f = fixture(t);
    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    const compiler = join(bin, 'flutter');
    writeFileSync(compiler, `#!${process.execPath}\nconst fs=require('node:fs');fs.mkdirSync('build/ios/iphonesimulator/Runner.app',{recursive:true});fs.writeFileSync('build/ios/iphonesimulator/Runner.app/Runner','first controlled output');\n`, { mode: 0o700 });
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
    const store = new Store(f.config.stateDir);
    t.after(() => store.close());
    const spec = structuredClone(product);
    delete spec.screenshotsDir;
    spec.channel = 'local';
    const job = store.enqueue(spec, f.config);
    mkdirSync(job.workspace, { recursive: true });
    writeFileSync(join(job.workspace, 'model.dart'), 'unchanged verified source');
    const digest = sourceDigest(job.workspace);
    const review = { approved: true, findings: [], acceptanceEvidence: product.acceptance.map(requirement => ({ requirement, evidence: 'Controlled scheduler fixture, not application acceptance' })) };
    const built = await executeStep(store, store.update(job.id, { stage: 'package', verifiedDigest: digest, verifiedDependencyDigest: dependencyDigest(job.workspace), review }));
    assert.equal(built.status, 'built');
    const oldArtifact = built.artifact;
    const retried = await run([process.execPath, cli, 'retry', job.id, '--build-only', '--config', f.configPath]);
    assert.equal(retried.code, 0, retried.stderr);
    const started = join(f.root, 'replacement-started');
    writeFileSync(compiler, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'started');${failure === 'interrupted' ? 'setInterval(()=>{},1000);' : failure === 'compiler-failure' ? 'process.exitCode=17;' : ''}\n`, { mode: 0o700 });
    const controller = new AbortController();
    const pending = executeStep(store, store.get(job.id), { signal: controller.signal });
    if (failure === 'interrupted') {
      try {
        const deadline = Date.now() + 5000;
        while (!existsSync(started) && Date.now() < deadline) await sleep(10);
        assert.equal(existsSync(started), true);
      } finally { controller.abort(); }
    }
    const failed = await pending;
    assert.notEqual(failed.status, 'built');
    assert.equal(failed.artifact, null);
    assert.equal(failed.ipaPath, null);
    assert.equal(failed.archiveDigest, null);
    assert.equal(existsSync(oldArtifact.path), false);
    assert.equal(failed.verifiedDigest, digest);
    assert.deepEqual(failed.review, review);
    assert.equal(store.get(job.id).artifact, null);
    assert.deepEqual(failed.groups, []);
  });
}

test('retry preserves queued proofs and budgets while adopting the current global configuration', async t => {
  const f = fixture(t);
  const store = new Store(f.config.stateDir);
  t.after(() => store.close());
  const job = store.enqueue(product, f.config);
  mkdirSync(job.workspace, { recursive: true });
  writeFileSync(join(job.workspace, 'model.dart'), 'Controlled verified source');
  const digest = sourceDigest(job.workspace);
  const before = store.update(job.id, {
    stage: 'package', status: 'blocked', error: 'Controlled blocked fixture; store machinery is gone, only local evidence exists',
    verifiedDigest: digest, verifiedDependencyDigest: dependencyDigest(job.workspace), verifiedAt: new Date().toISOString(),
    review: { approved: true, findings: [], acceptanceEvidence: product.acceptance.map(requirement => ({ requirement, evidence: 'Controlled retry fixture' })) },
    artifact: { kind: 'ios-simulator', path: join(f.root, 'controlled.app'), digest: 'a'.repeat(64), createdAt: new Date().toISOString() },
    attempts: { build: 2, verify: 1, package: 1 }, hostTurns: 3,
  });
  // A non-verification knob changes: retry must adopt the current config without touching proofs.
  const globalConfig = JSON.parse(readFileSync(f.configPath, 'utf8'));
  globalConfig.maxAttempts = 5;
  writeFileSync(f.configPath, JSON.stringify(globalConfig));
  const result = await run([process.execPath, cli, 'retry', job.id, '--build-only', '--config', f.configPath]);
  assert.equal(result.code, 0, result.stderr);
  const resumed = store.get(job.id);
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.stage, 'package');
  for (const field of ['verifiedDigest', 'verifiedDependencyDigest', 'verifiedAt', 'review', 'artifact', 'attempts', 'hostTurns', 'createdAt']) assert.deepEqual(resumed[field], before[field], field);
  assert.equal(resumed.config.maxAttempts, 5);
  assert.equal(resumed.config.packageTarget, 'simulator');
  assert.deepEqual(resumed.config.verification, loadConfig(f.configPath).verification);
  assert.equal(readFileSync(f.configPath, 'utf8'), JSON.stringify(globalConfig));
});

test('removed publication commands stay unavailable in the CLI', async () => {
  for (const command of ['authorize', 'feedback']) {
    const result = await run([process.execPath, cli, command, 'controlled-id', '--build-only']);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Unknown command/);
  }
});

for (const scenario of ['unchanged', 'changed-verification', 'changed-packaging', 'missing-source-proof']) {
  test(`CLI retry preserves proof or rejects without mutation: ${scenario}`, async t => {
    const f = fixture(t);
    const store = new Store(f.config.stateDir);
    t.after(() => store.close());
    const job = store.enqueue(product, f.config);
    mkdirSync(job.workspace, { recursive: true });
    writeFileSync(join(job.workspace, 'model.dart'), 'Controlled verified source');
    const digest = sourceDigest(job.workspace);
    const before = store.update(job.id, {
      status: 'blocked', stage: 'package',
      verifiedDigest: scenario === 'missing-source-proof' ? null : digest,
      verifiedDependencyDigest: dependencyDigest(job.workspace), verifiedAt: new Date().toISOString(),
      review: { approved: true, findings: [], acceptanceEvidence: product.acceptance.map(requirement => ({ requirement, evidence: 'Controlled retry fixture' })) },
      artifact: { kind: 'ios-simulator', path: join(f.root, 'controlled.app'), digest: 'a'.repeat(64), createdAt: new Date().toISOString() },
      receipt: { versionId: 'saved-version', buildId: 'saved-build' },
      attempts: { build: 2, verify: 1, package: 1 }, hostTurns: 3,
    });
    const globalConfig = JSON.parse(readFileSync(f.configPath, 'utf8'));
    if (scenario === 'changed-verification') globalConfig.verification.checks.push([process.execPath, '-e', 'process.exit(1)']);
    if (scenario === 'changed-packaging') globalConfig.packaging = { commands: [[process.execPath, '-e', 'process.exit(0)']], artifactPath: 'build/changed.app' };
    if (scenario.startsWith('changed-')) writeFileSync(f.configPath, JSON.stringify(globalConfig));
    const result = await run([process.execPath, cli, 'retry', job.id, '--config', f.configPath]);
    const resumed = store.get(job.id);
    if (scenario === 'unchanged') {
      assert.equal(result.code, 0, result.stderr);
      assert.equal(resumed.status, 'queued');
      for (const field of ['stage', 'verifiedDigest', 'verifiedDependencyDigest', 'verifiedAt', 'review', 'artifact', 'receipt', 'attempts', 'hostTurns', 'createdAt']) assert.deepEqual(resumed[field], before[field], field);
      assert.equal(resumed.config.packageTarget, loadConfig(f.configPath).packageTarget);
      assert.deepEqual(resumed.config.verification, loadConfig(f.configPath).verification);
      assert.equal(readFileSync(f.configPath, 'utf8'), JSON.stringify(globalConfig));
    } else if (scenario === 'missing-source-proof') {
      // Retry only re-queues; the packaging gate must refuse to build without a source proof.
      assert.equal(result.code, 0, result.stderr);
      assert.equal(resumed.status, 'queued');
      assert.equal(resumed.stage, 'package');
      assert.equal(resumed.verifiedDigest, null);
      const stepped = await run([process.execPath, cli, 'step', job.id, '--build-only', '--config', f.configPath]);
      assert.equal(stepped.code, 0, stepped.stderr);
      const gated = store.get(job.id);
      assert.equal(gated.status, 'waiting');
      assert.equal(gated.stage, 'build');
      assert.equal(gated.artifact, null);
      assert.match(gated.error, /stale evidence/);
    } else {
      // Verification contract changed: proofs are invalidated and the task returns to verify, budgets kept.
      assert.equal(result.code, 0, result.stderr);
      assert.equal(resumed.status, 'queued');
      assert.equal(resumed.stage, 'verify');
      assert.equal(resumed.verifiedDigest, null);
      assert.equal(resumed.verifiedDependencyDigest, null);
      assert.equal(resumed.verifiedAt, undefined);
      assert.equal(resumed.review, null);
      assert.equal(resumed.artifact, null);
      assert.deepEqual(resumed.receipt, before.receipt);
      assert.deepEqual(resumed.attempts, before.attempts);
      assert.equal(resumed.hostTurns, before.hostTurns);
    }
  });
}
