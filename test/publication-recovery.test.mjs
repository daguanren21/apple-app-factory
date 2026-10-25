import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { Store } from '../dist/store.js';
import { executeStep, sourceDigest } from '../dist/runner.js';
import { dependencyDigest } from '../dist/dependencies.js';

const example = JSON.parse(readFileSync(new URL('../examples/factory.json', import.meta.url)));
const product = JSON.parse(readFileSync(new URL('../examples/luggage.json', import.meta.url)));

function fixture(t, receipt = { upload: { status: 'delivered' }, versionId: 'version', buildId: 'build', submissionId: 'submission' }) {
  const root = mkdtempSync(join(tmpdir(), 'factory-publication-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const key = join(root, 'key.p8');
  writeFileSync(key, generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  for (const [name, value] of Object.entries({ ASC_KEY_ID: 'TESTKEY', ASC_ISSUER_ID: 'test-issuer', ASC_PRIVATE_KEY_PATH: key })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const configPath = join(root, 'factory.json');
  writeFileSync(configPath, JSON.stringify({ ...example, stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), allowLocalExecution: true, allowSubmit: true, packageTarget: 'ipa', maxAttempts: 2, maxJobHours: 1 }));
  const config = loadConfig(configPath);
  const store = new Store(config.stateDir);
  t.after(() => store.close());
  const apple = {
    appId: '123', bundleId: 'org.example.packing', version: '1.0', buildNumber: '1', locale: 'en-US',
    description: 'Offline packing lists.', keywords: 'packing,luggage', supportUrl: 'https://example.org/support', privacyPolicyUrl: 'https://example.org/privacy',
    reviewNotes: 'Offline utility; no account required.', copyright: 'Example Publisher',
    contact: { firstName: 'Review', lastName: 'Contact', email: 'review@example.org', phone: '+12025550123' }, manualSetupConfirmed: true,
  };
  let job = store.enqueue({ ...product, apple }, config);
  mkdirSync(join(job.workspace, 'build'), { recursive: true });
  writeFileSync(join(job.workspace, 'source.dart'), 'verified source');
  const ipaPath = join(job.workspace, 'build', 'verified.ipa');
  writeFileSync(ipaPath, 'verified IPA');
  job = store.update(job.id, {
    stage: 'publish', createdAt: Date.now() - 2 * 3600000, ipaPath,
    archiveDigest: createHash('sha256').update(readFileSync(ipaPath)).digest('hex'), verifiedDigest: sourceDigest(job.workspace), verifiedDependencyDigest: dependencyDigest(job.workspace), receipt,
    agentCalls: config.maxAgentCalls, attempts: { build: config.maxAttempts, verify: config.maxAttempts, publish: config.maxAttempts },
  });
  const requests = [];
  let outcome;
  const remote = { state: 'WAITING_FOR_REVIEW' };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: options.method });
    assert.equal(options.method, 'GET', 'Recovery must not replay any write or invoke the uploader');
    if (outcome === 'transport') throw new TypeError('Controlled GET transport failure');
    if (typeof outcome === 'number') return Response.json({ errors: [{ code: 'CONTROLLED', detail: 'Controlled response' }] }, { status: outcome });
    if (outcome === 'body-loss') return { ok: true, status: 200, text: async () => { throw new TypeError('Controlled response body loss'); } };
    if (outcome === 'malformed') return new Response('Truncated JSON', { status: 200 });
    if (outcome === 'invalid-resource') return Response.json({ data: { id: 123 } });
    if (path === '/v1/apps/123') return Response.json({ data: { id: '123', attributes: { bundleId: apple.bundleId } } });
    if (path === '/v1/apps/123/appStoreVersions') return Response.json({ data: [{ id: 'version', attributes: { appVersionState: remote.state } }] });
    if (path === '/v1/appStoreVersions/version/build') return Response.json({ data: { id: 'build' } });
    if (path === '/v1/reviewSubmissions/submission') return Response.json({ data: { id: 'submission', attributes: { state: 'WAITING_FOR_REVIEW' } } });
    if (path === '/v1/reviewSubmissions/submission/items') return Response.json({ data: [{ id: 'item', relationships: { appStoreVersion: { data: { id: 'version' } } } }] });
    assert.fail(`Unexpected recovery request ${path}`);
  });
  return { store, job, config, requests, remote, setOutcome(value) { outcome = value; }, step: () => executeStep(store, store.get(job.id)) };
}

for (const outcome of ['transport', 503, 408, 429, 'body-loss']) {
  test(`durable publish recovery survives exhausted limits and transient reads: ${outcome}`, async t => {
    const f = fixture(t);
    const receipt = structuredClone(f.job.receipt);
    f.setOutcome(outcome);
    for (let count = 0; count < f.config.maxAttempts + 2; count++) {
      const result = await f.step();
      assert.equal(result.status, 'waiting');
      assert.equal(result.stage, 'publish');
      assert.deepEqual(result.receipt, receipt);
      assert.equal(result.agentCalls, f.config.maxAgentCalls);
      assert.equal(result.attempts.build, f.config.maxAttempts);
      assert.equal(result.attempts.verify, f.config.maxAttempts);
    }
    f.setOutcome(undefined);
    const resumed = await f.step();
    assert.equal(resumed.stage, 'monitor');
    assert.equal(resumed.status, 'waiting');
    assert.equal(resumed.receipt.phase, 'submitted');
    assert.equal(resumed.receipt.upload.status, 'delivered');
    f.remote.state = 'PENDING_DEVELOPER_RELEASE';
    assert.equal((await f.step()).status, 'approved');
    assert.equal(f.store.get(f.job.id).agentCalls, f.config.maxAgentCalls);
  });
}

test('pending remote effects retain their receipt through transient read failures without another write', async t => {
  const f = fixture(t, { versionId: 'version', buildId: 'build', submissionId: 'submission', pending: { key: 'submit-review' } });
  f.setOutcome('transport');
  for (let count = 0; count < 4; count++) {
    assert.equal((await f.step()).status, 'waiting');
    assert.equal(f.store.get(f.job.id).receipt.pending.key, 'submit-review');
  }
  f.setOutcome(undefined);
  assert.equal((await f.step()).stage, 'monitor');
  assert.equal(f.store.get(f.job.id).receipt.pending, null);
});

for (const stage of ['publish', 'monitor']) {
  for (const outcome of [401, 403, 422, 'malformed', 'invalid-resource', 'missing-credentials']) {
    test(`nontransient ${stage} failures block for explicit action: ${outcome}`, async t => {
      const f = fixture(t);
      f.store.update(f.job.id, { stage });
      if (outcome === 'missing-credentials') delete process.env.ASC_KEY_ID;
      else f.setOutcome(outcome);
      const result = await f.step();
      assert.equal(result.status, 'blocked');
      assert.deepEqual(result.receipt, f.job.receipt);
      assert.equal(result.agentCalls, f.config.maxAgentCalls);
      assert.equal(f.store.next(), undefined);
    });
  }
}

test('uncertain upload receipts remain blocked even after engineering limits expire', async t => {
  const f = fixture(t, { upload: { status: 'intent' } });
  assert.equal((await f.step()).status, 'blocked');
  assert.equal(f.requests.length, 0);
  assert.equal(f.store.get(f.job.id).receipt.buildId, undefined);
  assert.equal(f.store.next(), undefined);
});

for (const change of ['source', 'archive']) {
  test(`recovery retains the verified ${change} guard after the wall-clock limit`, async t => {
    const f = fixture(t);
    writeFileSync(change === 'source' ? join(f.job.workspace, 'source.dart') : f.job.ipaPath, 'unverified mutation');
    const result = await f.step();
    assert.notEqual(result.status, 'approved');
    assert.equal(f.requests.length, 0);
    assert.deepEqual(result.receipt, f.job.receipt);
  });
}

test('engineering stages remain bounded when publication recovery bypasses wall-clock limits', async t => {
  const f = fixture(t);
  f.store.update(f.job.id, { stage: 'build' });
  const result = await f.step();
  assert.equal(result.status, 'failed');
  assert.equal(result.agentCalls, f.config.maxAgentCalls);
  assert.equal(result.attempts.build, f.config.maxAttempts);
  assert.equal(f.requests.length, 0);
});

for (const stage of ['build', 'review']) {
  test(`publication recovery does not replenish the ${stage} budget`, async t => {
    const f = fixture(t);
    f.store.update(f.job.id, { stage, createdAt: Date.now() });
    const result = await f.step();
    assert.equal(result.status, 'failed');
    assert.equal(result.agentCalls, f.config.maxAgentCalls);
    assert.equal(result.attempts.build, f.config.maxAttempts);
    assert.equal(f.requests.length, 0);
  });
}

test('monitor transport failures recover beyond publication and engineering limits', async t => {
  const f = fixture(t);
  f.store.update(f.job.id, { stage: 'monitor', attempts: { ...f.job.attempts, monitor: f.config.maxAttempts } });
  f.setOutcome('transport');
  for (let count = 0; count < 4; count++) {
    const result = await f.step();
    assert.equal(result.status, 'waiting');
    assert.deepEqual(result.receipt, f.job.receipt);
    assert.equal(result.agentCalls, f.config.maxAgentCalls);
    assert.equal(result.attempts.build, f.config.maxAttempts);
  }
  f.setOutcome(undefined);
  f.remote.state = 'PENDING_DEVELOPER_RELEASE';
  assert.equal((await f.step()).status, 'approved');
});
