import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../dist/process.js';

const example = JSON.parse(readFileSync(new URL('../examples/factory.json', import.meta.url)));
const product = JSON.parse(readFileSync(new URL('../examples/luggage.json', import.meta.url)));
const documented = {
  ...product,
  apple: {
    ...product.apple, appId: '123', description: 'Offline packing and luggage weight planning.', keywords: 'packing,luggage',
    supportUrl: 'https://example.org/support', privacyPolicyUrl: 'https://example.org/privacy',
    reviewNotes: 'Controlled local metadata fixture.', copyright: 'Example Publisher',
    contact: { firstName: 'Review', lastName: 'Contact', email: 'review@example.org', phone: '+12025550123' },
    manualSetupConfirmed: true,
  },
};
const cli = resolve('dist/cli.js');

function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'factory-submit-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const inbox = join(root, 'requirements');
  const workspaceRoot = join(root, 'workspaces');
  const configPath = join(root, 'factory.json');
  writeFileSync(configPath, JSON.stringify({ ...example, stateDir, workspaceRoot, inbox: { directory: inbox }, ...overrides }));
  return { root, stateDir, inbox, workspaceRoot, configPath };
}

function submit(f, value = product, args = []) {
  return run([process.execPath, cli, 'submit', '-', '--config', f.configPath, ...args], { input: JSON.stringify(value) });
}

function assertNoExecution(f) {
  assert.equal(existsSync(f.workspaceRoot), false);
}

for (const state of ['absent', 'file', 'directory']) {
  test(`submit CLI publishes without creating or touching queue state: ${state}`, async t => {
    const f = fixture(t);
    mkdirSync(f.inbox);
    if (state === 'file') writeFileSync(f.stateDir, 'queue state is unavailable');
    if (state === 'directory') {
      mkdirSync(f.stateDir);
      writeFileSync(join(f.stateDir, 'sentinel'), 'unchanged queue state');
    }
    const before = state === 'absent' ? null : statSync(f.stateDir, { bigint: true });
    const result = await submit(f);
    assert.equal(result.code, 0, result.stderr);
    const published = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(published), ['path']);
    assert.deepEqual(readdirSync(f.inbox), [published.path.slice(f.inbox.length + 1)]);
    assert.equal(JSON.parse(readFileSync(published.path, 'utf8')).id, product.id);
    if (before === null) assert.equal(existsSync(f.stateDir), false);
    else {
      const after = statSync(f.stateDir, { bigint: true });
      for (const field of ['ino', 'size', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field], field);
      if (state === 'file') assert.equal(readFileSync(f.stateDir, 'utf8'), 'queue state is unavailable');
      else {
        assert.deepEqual(readdirSync(f.stateDir), ['sentinel']);
        assert.equal(readFileSync(join(f.stateDir, 'sentinel'), 'utf8'), 'unchanged queue state');
      }
    }
    assertNoExecution(f);
  });
}

test('concurrent identical CLI submissions publish one immutable requirement', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => submit(f)));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const paths = results.map(result => JSON.parse(result.stdout).path);
  assert.equal(new Set(paths).size, 1);
  assert.equal(readdirSync(f.inbox).length, 1);
  const bytes = readFileSync(paths[0]);
  const before = statSync(paths[0], { bigint: true });
  const repeated = await submit(f);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).path, paths[0]);
  assert.deepEqual(readFileSync(paths[0]), bytes);
  const after = statSync(paths[0], { bigint: true });
  for (const field of ['ino', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field], field);
  assert.equal(existsSync(f.stateDir), false);
  assertNoExecution(f);
});

test('competing CLI submissions never overwrite the winning requirement', async t => {
  const f = fixture(t);
  const requests = [product, { ...product, name: `${product.name} alternative` }];
  const results = await Promise.all(requests.map(value => submit(f, value)));
  const winner = results.findIndex(result => result.code === 0);
  assert.notEqual(winner, -1);
  const loser = 1 - winner;
  assert.notEqual(results[loser].code, 0);
  const path = JSON.parse(results[winner].stdout).path;
  const bytes = readFileSync(path);
  assert.equal(JSON.parse(bytes).name, requests[winner].name);
  const before = statSync(path, { bigint: true });
  const retry = await submit(f, requests[loser]);
  assert.notEqual(retry.code, 0);
  assert.deepEqual(readFileSync(path), bytes);
  const after = statSync(path, { bigint: true });
  for (const field of ['ino', 'mtimeNs', 'ctimeNs']) assert.equal(after[field], before[field], field);
  assert.equal(readdirSync(f.inbox).length, 1);
  assert.equal(existsSync(f.stateDir), false);
  assertNoExecution(f);
});

for (const kind of ['invalid-json', 'unknown-field', 'invalid-configuration']) {
  test(`submit CLI rejects ${kind} before writing inbox or queue`, async t => {
    const f = fixture(t, kind === 'invalid-configuration' ? { packageTarget: 'aab' } : {});
    const input = kind === 'invalid-json' ? '{' : JSON.stringify(kind === 'unknown-field' ? { ...product, unknownField: true } : { ...product, framework: 'android-java' });
    const result = await run([process.execPath, cli, 'submit', '-', '--config', f.configPath], { input });
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
    assert.equal(existsSync(f.inbox), false);
    assert.equal(existsSync(f.stateDir), false);
    assertNoExecution(f);
  });
}

test('app-store submit accepts minimal apple documentation', async t => {
  const f = fixture(t, { packageTarget: 'ipa' });
  const minimal = { ...product, apple: { bundleId: product.apple.bundleId, buildNumber: product.apple.buildNumber } };
  const result = await submit(f, minimal);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(JSON.parse(result.stdout).path, 'utf8')), minimal);
  assert.equal(existsSync(f.stateDir), false);
  assertNoExecution(f);
});

test('submit accepts a spec with apple omitted entirely', async t => {
  const f = fixture(t, { packageTarget: 'ipa' });
  const { apple, ...withoutApple } = product;
  const result = await submit(f, withoutApple);
  assert.equal(result.code, 0, result.stderr);
  const published = JSON.parse(result.stdout);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(published.path, 'utf8')), 'apple'), false);
  assert.equal(existsSync(f.stateDir), false);
  assertNoExecution(f);
});

test('submit accepts complete controlled metadata as optional owner documentation without opening queue state', async t => {
  const f = fixture(t, { packageTarget: 'ipa' });
  const result = await submit(f, documented);
  assert.equal(result.code, 0, result.stderr);
  const published = JSON.parse(result.stdout);
  assert.deepEqual(JSON.parse(readFileSync(published.path, 'utf8')), documented);
  assert.deepEqual(readdirSync(f.inbox), [published.path.slice(f.inbox.length + 1)]);
  assert.equal(existsSync(f.stateDir), false);
  assertNoExecution(f);
});

test('submit refuses removed publication permissions in the configuration', async t => {
  const f = fixture(t, { packageTarget: 'ipa' });
  const configPath = f.configPath;
  writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf8')), allowSubmit: true }));
  const result = await submit(f);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unrecognized_keys/);
  assert.equal(existsSync(f.inbox), false);
  assert.equal(existsSync(f.stateDir), false);
  assertNoExecution(f);
});

for (const [framework, platform, channel, packageTarget] of [
  ['swift', 'ios', 'local', 'simulator'],
  ['android-java', 'android', 'google-play', 'aab'],
]) {
  test(`${framework} ${channel} submit CLI needs no Apple metadata`, async t => {
    const f = fixture(t, {
      packageTarget,
      packaging: { commands: [['owner-build']], artifactPath: 'build/artifact' },
    });
    const result = await submit(f, { ...product, framework, platform, channel, apple: undefined });
    assert.equal(result.code, 0, result.stderr);
    const published = JSON.parse(result.stdout);
    const request = JSON.parse(readFileSync(published.path, 'utf8'));
    assert.equal(request.framework, framework);
    assert.equal(request.channel, channel);
    assert.equal(Object.hasOwn(request, 'apple'), false);
    assert.equal(existsSync(f.stateDir), false);
    assertNoExecution(f);
  });
}
