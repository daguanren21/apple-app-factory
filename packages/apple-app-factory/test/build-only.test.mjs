import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { Store } from '../dist/store.js';
import { sourceDigest, executeStep } from '../dist/runner.js';
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
    delete spec.apple.screenshotsDir;
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

test('build-only CLI refuses publication configuration before creating a queue', async t => {
  const f = fixture(t, { packageTarget: 'ipa', allowSubmit: true });
  const result = await run([process.execPath, cli, 'enqueue', '-', '--build-only', '--config', f.configPath], { input: JSON.stringify(product) });
  assert.notEqual(result.code, 0);
  assert.equal(existsSync(f.config.stateDir), false);
});

test('build-only step refuses previously authorized queued work without claiming it', async t => {
  const f = fixture(t);
  const store = new Store(f.config.stateDir);
  t.after(() => store.close());
  const job = store.enqueue(product, { ...f.config, packageTarget: 'ipa', allowSubmit: true });
  const before = store.update(job.id, { stage: 'verify' });
  const result = await run([process.execPath, cli, 'step', job.id, '--build-only', '--config', f.configPath]);
  assert.notEqual(result.code, 0);
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
  assert.equal(saved.config.allowSubmit, false);
  assert.equal(saved.config.allowRelease, false);
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
    delete spec.apple.screenshotsDir;
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

for (const action of ['retry', 'feedback']) {
  test(`${action} preserves an authorized IPA task when global configuration remains build-only`, async t => {
    const f = fixture(t);
    const store = new Store(f.config.stateDir);
    t.after(() => store.close());
    const job = store.enqueue(product, { ...f.config, packageTarget: 'ipa', allowSubmit: true, allowRelease: false });
    store.update(job.id, { stage: action === 'feedback' ? 'monitor' : 'package', status: 'blocked', ...(action === 'feedback' ? { appleReview: { status: 'rejected', detail: 'Controlled review feedback fixture' } } : {}) });
    const feedback = join(f.root, 'feedback.txt');
    writeFileSync(feedback, 'Controlled feedback fixture; no Apple submission is claimed.');
    const result = await run([process.execPath, cli, action, job.id, ...(action === 'feedback' ? [feedback] : []), '--config', f.configPath]);
    assert.equal(result.code, 0, result.stderr);
    const resumed = store.get(job.id);
    assert.equal(resumed.config.packageTarget, 'ipa');
    assert.equal(resumed.config.allowSubmit, true);
    assert.equal(resumed.config.allowRelease, false);
    assert.equal(loadConfig(f.configPath).packageTarget, 'simulator');
    assert.equal(loadConfig(f.configPath).allowSubmit, false);
  });
}
