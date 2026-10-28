import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pollApple, shipApple } from '../dist/apple.js';

const spec = {
  platform: 'ios', channel: 'app-store',
  version: '1.0',
  apple: {
    appId: '123', bundleId: 'org.example.packing', buildNumber: '1', locale: 'en-US',
    description: 'Offline packing and luggage weight planning.', keywords: 'packing,luggage',
    supportUrl: 'https://example.org/support', privacyPolicyUrl: 'https://example.org/privacy',
    reviewNotes: 'Offline packing lists and weight calculations; no account is required.', copyright: 'Example Publisher',
    contact: { firstName: 'Review', lastName: 'Contact', email: 'review@example.org', phone: '+12025550123' },
    manualSetupConfirmed: true,
  },
};

async function credentials(t, curve = 'prime256v1') {
  const directory = await mkdtemp(join(tmpdir(), 'factory-apple-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pair = generateKeyPairSync('ec', { namedCurve: curve });
  const path = join(directory, 'key.p8');
  await writeFile(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { env: { ASC_KEY_ID: 'TESTKEY', ASC_ISSUER_ID: 'test-issuer', ASC_PRIVATE_KEY_PATH: path }, publicKey: pair.publicKey };
}

function network(t, handler) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: new URL(url), ...options });
    const result = await handler(new URL(url), options);
    return result instanceof Response || typeof result?.text === 'function' ? result : Response.json(result);
  });
  return requests;
}

function submissionNetwork(t, state = 'WAITING_FOR_REVIEW') {
  return network(t, url => {
    if (url.pathname === '/v1/apps/123') return { data: { type: 'apps', id: '123', attributes: { bundleId: spec.apple.bundleId } } };
    if (url.pathname === '/v1/apps/123/appStoreVersions') return { data: [{ type: 'appStoreVersions', id: 'version', attributes: { appVersionState: 'READY_FOR_REVIEW' } }] };
    if (url.pathname === '/v1/reviewSubmissions/submission') return { data: { type: 'reviewSubmissions', id: 'submission', attributes: { state } } };
    if (url.pathname === '/v1/reviewSubmissions/submission/items') return { data: [{ id: 'item', relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'version' } } } }] };
    if (url.pathname === '/v1/appStoreVersions/version/build') return { data: { id: 'build' } };
    assert.fail(`Unexpected request: ${url.pathname}`);
  });
}

test('shipping requires publisher legal/privacy attestation before accessing the network', async t => {
  const requests = network(t, () => assert.fail('No API call is allowed before publisher setup'));
  await assert.rejects(shipApple({ spec: { ...spec, apple: { ...spec.apple, manualSetupConfirmed: false } }, save: async () => {} }), error => error.code === 'APPLE_SETUP_REQUIRED' && /privacy disclosures/.test(error.message));
  assert.equal(requests.length, 0);
});

test('a receipt from another app/build cannot authorize shipping', async t => {
  network(t, () => assert.fail('A mismatched receipt must not reach Apple'));
  await assert.rejects(shipApple({ spec, state: { identity: { appId: 'another-app' } }, save: async () => {} }), { code: 'APPLE_STATE_MISMATCH' });
});

test('polling rejects absent credentials and non-P-256 keys', async t => {
  network(t, () => assert.fail('Invalid credentials must not reach Apple'));
  await assert.rejects(pollApple({ spec, env: {} }), error => error.code === 'APPLE_SETUP_REQUIRED' && /ASC_KEY_ID/.test(error.message));
  const { env } = await credentials(t, 'secp384r1');
  await assert.rejects(pollApple({ spec, env }), error => error.code === 'APPLE_SETUP_REQUIRED' && /P-256/.test(error.message));
});

test('polling uses a verifiable ES256 team JWT and distinguishes approval, rejection and waiting', async t => {
  const { env, publicKey } = await credentials(t);
  let state = 'PENDING_DEVELOPER_RELEASE';
  network(t, (url, options) => {
    assert.equal(url.origin, 'https://api.appstoreconnect.apple.com');
    if (url.pathname === '/v1/appStoreVersions/version/build') return { data: { id: 'build' } };
    assert.equal(url.searchParams.get('filter[versionString]'), '1.0');
    assert.equal(url.searchParams.get('filter[platform]'), 'IOS');
    const [header, payload, signature] = options.headers.Authorization.slice('Bearer '.length).split('.');
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'TESTKEY', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(claims.iss, env.ASC_ISSUER_ID);
    assert.equal(claims.aud, 'appstoreconnect-v1');
    assert.ok(claims.exp > Math.floor(Date.now() / 1000));
    assert.ok(claims.exp - claims.iat <= 1200);
    assert.equal(Buffer.from(signature, 'base64url').length, 64);
    assert.equal(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
    return { data: [{ id: 'version', attributes: { appVersionState: state } }] };
  });
  const result = await pollApple({ spec, env, state: { versionId: 'version', buildId: 'build' } });
  assert.equal(result.status, 'approved');
  assert.equal(result.available, false);
  assert.equal(result.distributionReady, false);
  state = 'METADATA_REJECTED';
  assert.equal((await pollApple({ spec, env })).status, 'rejected');
  state = 'WAITING_FOR_REVIEW';
  assert.equal((await pollApple({ spec, env })).status, 'waiting');
  await assert.rejects(pollApple({ spec, env, state: { versionId: 'different-version' } }), { code: 'APPLE_STATE_MISMATCH' });
});

test('resuming an accepted review write reconciles without any external write or upload', async t => {
  const { env } = await credentials(t);
  const requests = submissionNetwork(t);
  const saves = [];
  const result = await shipApple({ spec, env, state: { versionId: 'version', buildId: 'build', submissionId: 'submission', pending: { key: 'submit-review' } }, save: async value => saves.push(value), run: async () => assert.fail('A resumed submission must not upload again') });
  assert.equal(result.phase, 'submitted');
  assert.equal(result.pending, null);
  assert.equal(saves.some(value => value.lastEffect?.reconciled === true), true);
  assert.equal(requests.every(request => request.method === 'GET'), true);
});

test('an uncertain submit that still appears as a draft is never blindly retried', async t => {
  const { env } = await credentials(t);
  const requests = submissionNetwork(t, 'READY_FOR_REVIEW');
  await assert.rejects(shipApple({ spec, env, state: { versionId: 'version', submissionId: 'submission', buildId: 'build', pending: { key: 'submit-review' } }, save: async () => {}, run: async () => assert.fail('No upload is allowed') }), { code: 'APPLE_WRITE_UNCERTAIN' });
  assert.equal(requests.every(request => request.method === 'GET'), true);
});

test('public release requires an exact bundle and version in the configured storefront', async t => {
  const { env } = await credentials(t);
  const localized = { ...spec, apple: { ...spec.apple, storefrontCountry: 'US' } };
  let listing = { bundleId: 'another.app', version: spec.version };
  network(t, (url, options) => {
    if (url.pathname === '/v1/appStoreVersions/version/build') return { data: { id: 'build' } };
    if (url.origin === 'https://api.appstoreconnect.apple.com') return { data: [{ id: 'version', attributes: { appVersionState: 'READY_FOR_DISTRIBUTION' } }] };
    assert.equal(url.origin, 'https://itunes.apple.com');
    assert.equal(url.searchParams.get('country'), 'US');
    assert.equal(options.headers, undefined);
    return { results: [listing] };
  });
  const receipt = { versionId: 'version', buildId: 'build' };
  assert.equal((await pollApple({ spec: localized, env, state: receipt })).available, false);
  listing = { bundleId: spec.apple.bundleId, version: '0.9' };
  assert.equal((await pollApple({ spec: localized, env, state: receipt })).available, false);
  listing = { bundleId: spec.apple.bundleId, version: spec.version };
  assert.equal((await pollApple({ spec: localized, env, state: receipt })).available, true);
});

const screenshotBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const screenshotChecksum = createHash('md5').update(screenshotBytes).digest('hex');

async function shippingFixture(t, { createOutcomes = [], localScreenshots = false, beforeRequest, initialReceipt, uploadExitCode } = {}) {
  const { env } = await credentials(t);
  const directory = await mkdtemp(join(tmpdir(), 'factory-apple-shipping-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ipaPath = join(directory, 'verified.ipa');
  await writeFile(ipaPath, 'Previously uploaded archive fixture');
  const apple = { ...spec.apple };
  const screenshotsDir = localScreenshots ? join(directory, 'screenshots') : undefined;
  if (screenshotsDir) {
    await mkdir(join(screenshotsDir, 'APP_IPHONE_67'), { recursive: true });
    await writeFile(join(screenshotsDir, 'APP_IPHONE_67', 'packing.png'), screenshotBytes);
  }
  const remote = {
    versionState: 'PREPARE_FOR_SUBMISSION', selectedBuildId: 'build',
    buildVisible: initialReceipt === undefined || !!initialReceipt.buildId || initialReceipt.upload?.status === 'delivered', buildId: 'build', uploads: 0,
    submissions: [], items: [], createAttempts: 0, created: 0, submitted: 0,
    sets: [{ type: 'appScreenshotSets', id: 'screenshots', attributes: { screenshotDisplayType: 'APP_IPHONE_67' } }],
    shots: { screenshots: [{ type: 'appScreenshots', id: 'packing', attributes: { fileName: 'packing.png', sourceFileChecksum: screenshotChecksum, assetDeliveryState: { state: 'COMPLETE' } } }] },
  };
  const resource = (type, id, attributes) => ({ type, id, attributes });
  const requests = network(t, async (url, options) => {
    await beforeRequest?.(url, options, remote);
    const path = url.pathname;
    if (options.method === 'GET') {
      if (path === '/v1/apps/123') return { data: resource('apps', '123', { bundleId: apple.bundleId }) };
      if (path === '/v1/apps/123/appStoreVersions') return { data: [resource('appStoreVersions', 'version', { appVersionState: remote.versionState, copyright: apple.copyright, releaseType: 'MANUAL' })] };
      if (path === '/v1/builds') return { data: remote.buildVisible ? [resource('builds', remote.buildId, { processingState: 'VALID', usesNonExemptEncryption: false })] : [] };
      if (path === '/v1/appStoreVersions/version/appStoreVersionLocalizations') return { data: [resource('appStoreVersionLocalizations', 'locale', { locale: apple.locale, description: apple.description, keywords: apple.keywords, supportUrl: apple.supportUrl })] };
      if (path === '/v1/apps/123/appInfos') return { data: [resource('appInfos', 'info', { state: 'PREPARE_FOR_SUBMISSION' })] };
      if (path === '/v1/appInfos/info/appInfoLocalizations') return { data: [resource('appInfoLocalizations', 'info-locale', { locale: apple.locale, privacyPolicyUrl: apple.privacyPolicyUrl })] };
      if (path === '/v1/appStoreVersions/version/appStoreReviewDetail') return { data: resource('appStoreReviewDetails', 'review', { contactFirstName: apple.contact.firstName, contactLastName: apple.contact.lastName, contactEmail: apple.contact.email, contactPhone: apple.contact.phone, notes: apple.reviewNotes, demoAccountRequired: false }) };
      if (path === '/v1/appStoreVersionLocalizations/locale/appScreenshotSets') return { data: remote.sets };
      const screenshots = path.match(/^\/v1\/appScreenshotSets\/([^/]+)\/appScreenshots$/);
      if (screenshots) return { data: remote.shots[screenshots[1]] ?? [] };
      if (path === '/v1/appStoreVersions/version/build') return remote.selectedBuildId ? { data: resource('builds', remote.selectedBuildId, {}) } : new Response(null, { status: 404 });
      if (path === '/v1/reviewSubmissions') return { data: remote.submissions };
      if (path === '/v1/reviewSubmissions/submission') return { data: remote.submissions[0] };
      if (path === '/v1/reviewSubmissions/submission/items') return { data: remote.items };
    }
    if (path === '/v1/reviewSubmissions' && options.method === 'POST') {
      remote.createAttempts++;
      const outcome = createOutcomes.shift();
      if (typeof outcome === 'number') return Response.json({ errors: [{ code: 'REJECTED', detail: 'Publisher request rejected' }] }, { status: outcome });
      if (outcome === 'non-json-rejection') return new Response('Request rejected', { status: 400 });
      if (outcome === 'lost-body-rejection') return { ok: false, status: 429, text: async () => { throw new TypeError('Rejection response body lost'); } };
      if (outcome === 'timeout') throw new DOMException('Request timed out', 'TimeoutError');
      remote.created++;
      assert.equal(remote.created, 1, 'A remote review submission must not be duplicated');
      const submission = resource('reviewSubmissions', 'submission', { state: 'READY_FOR_REVIEW' });
      remote.submissions.push(submission);
      if (outcome === 'lost-success') throw new TypeError('Connection closed after Apple accepted the write');
      if (outcome === 'lost-body-success') return { ok: true, status: 201, text: async () => { throw new TypeError('Response body lost'); } };
      if (outcome === 'malformed-success') return new Response('Truncated JSON', { status: 201 });
      return { data: submission };
    }
    if (path === '/v1/reviewSubmissionItems' && options.method === 'POST') {
      assert.equal(remote.items.length, 0, 'The version must not be added twice');
      const item = { type: 'reviewSubmissionItems', id: 'item', relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'version' } } } };
      remote.items.push(item);
      return { data: item };
    }
    if (path === '/v1/reviewSubmissions/submission' && options.method === 'PATCH') {
      assert.equal(remote.items.length, 1);
      remote.submitted++;
      remote.submissions[0].attributes.state = 'WAITING_FOR_REVIEW';
      remote.versionState = 'WAITING_FOR_REVIEW';
      return { data: remote.submissions[0] };
    }
    assert.fail(`Unexpected Apple operation: ${options.method} ${path}`);
  });
  let saved = initialReceipt ?? { versionId: 'version', buildId: 'build', upload: { status: 'delivered' } };
  const saves = [];
  return {
    remote, requests, saves,
    get saved() { return saved; },
    ship: () => shipApple({ spec: { ...spec, apple, screenshotsDir }, ipaPath, env, state: saved, save: async value => { saved = value; saves.push(value); }, run: async argv => {
      if (uploadExitCode === undefined) assert.fail('Recovery must not upload the archive again');
      if (argv.includes('--help')) return { code: 0, stdout: '--upload-package', stderr: '' };
      remote.uploads++;
      if (uploadExitCode === 0) remote.buildVisible = true;
      return { code: uploadExitCode, stdout: '', stderr: uploadExitCode === 0 ? '' : 'Controlled delivery failure' };
    } }),
  };
}

test('definitively rejected review creation can resume and create exactly one submission', async t => {
  for (const rejection of [400, 401, 403, 409, 422, 429, 'non-json-rejection', 'lost-body-rejection']) {
    await t.test(String(rejection), async t => {
      const fixture = await shippingFixture(t, { createOutcomes: [rejection] });
      const status = typeof rejection === 'number' ? rejection : rejection === 'lost-body-rejection' ? 429 : 400;
      await assert.rejects(fixture.ship(), error => error.httpStatus === status && error.outcome === 'rejected' && error.code === (status === 429 ? 'APPLE_RATE_LIMIT' : 'APPLE_SETUP_REQUIRED'));
      assert.equal(fixture.saved.pending, null);
      assert.equal(fixture.remote.created, 0);
      assert.equal((await fixture.ship()).phase, 'submitted');
      assert.equal(fixture.remote.createAttempts, 2);
      assert.equal(fixture.remote.created, 1);
      assert.equal(fixture.remote.items.length, 1);
      assert.equal(fixture.remote.submitted, 1);
      assert.equal((await fixture.ship()).phase, 'submitted');
      assert.equal(fixture.remote.createAttempts, 2);
      assert.equal(fixture.remote.submitted, 1);
    });
  }
});

test('ambiguous review creation retains intent and never duplicates a possibly accepted write', async t => {
  for (const outcome of ['lost-success', 'lost-body-success', 'malformed-success', 'timeout', 408, 500, 503]) {
    await t.test(String(outcome), async t => {
      const fixture = await shippingFixture(t, { createOutcomes: [outcome] });
      const status = typeof outcome === 'number' ? outcome : ['lost-body-success', 'malformed-success'].includes(outcome) ? 201 : null;
      await assert.rejects(fixture.ship(), error => error.outcome === 'unknown' && error.httpStatus === status);
      assert.equal(fixture.saved.pending.key, 'create-review-submission');
      await assert.rejects(fixture.ship(), { code: 'APPLE_WRITE_UNCERTAIN' });
      assert.equal(fixture.remote.createAttempts, 1);
      assert.equal(fixture.remote.created, ['lost-success', 'lost-body-success', 'malformed-success'].includes(outcome) ? 1 : 0);
      assert.equal(fixture.remote.submitted, 0);
    });
  }
});

test('submitted work cannot resume when the selected build identity is missing or replaced', async t => {
  for (const selected of [null, 'replacement-build']) {
    await t.test(String(selected), async t => {
      const fixture = await shippingFixture(t);
      await fixture.ship();
      fixture.remote.selectedBuildId = selected;
      const count = fixture.saves.length;
      await assert.rejects(fixture.ship(), { code: 'APPLE_STATE_MISMATCH' });
      assert.equal(fixture.saves.slice(count).some(value => value.phase === 'submitted' && value.lastEffect?.reconciled), false);
      assert.equal(fixture.remote.created, 1);
      assert.equal(fixture.remote.submitted, 1);
    });
  }
});

test('a missing saved build ID cannot authorize already-submitted work', async t => {
  const { env } = await credentials(t);
  const requests = submissionNetwork(t);
  await assert.rejects(shipApple({ spec, env, state: { versionId: 'version', submissionId: 'submission' }, save: async () => {}, run: async () => assert.fail('No archive upload is allowed') }), { code: 'APPLE_STATE_MISMATCH' });
  assert.equal(requests.every(request => request.method === 'GET'), true);
});

test('approval and public release are never attributed to a missing or replaced build', async t => {
  for (const versionState of ['PENDING_DEVELOPER_RELEASE', 'READY_FOR_DISTRIBUTION']) {
    await t.test(versionState, async t => {
      const { env } = await credentials(t);
      let selected = 'replacement-build';
      let lookups = 0;
      network(t, url => {
        if (url.origin === 'https://itunes.apple.com') {
          lookups++;
          return { results: [{ bundleId: spec.apple.bundleId, version: spec.version }] };
        }
        if (url.pathname === '/v1/appStoreVersions/version/build') return selected ? { data: { id: selected } } : new Response(null, { status: 404 });
        return { data: [{ id: 'version', attributes: { appVersionState: versionState } }] };
      });
      const monitor = state => pollApple({ spec: { ...spec, apple: { ...spec.apple, storefrontCountry: 'US' } }, state, env });
      await assert.rejects(monitor({ versionId: 'version', buildId: 'build' }), { code: 'APPLE_STATE_MISMATCH' });
      selected = null;
      await assert.rejects(monitor({ versionId: 'version', buildId: 'build' }), { code: 'APPLE_STATE_MISMATCH' });
      selected = 'build';
      await assert.rejects(monitor({ versionId: 'version' }), { code: 'APPLE_STATE_MISMATCH' });
      assert.equal(lookups, 0);
      const result = await monitor({ versionId: 'version', buildId: 'build' });
      assert.equal(result.status, 'approved');
      assert.equal(result.available, versionState === 'READY_FOR_DISTRIBUTION');
    });
  }
});

test('local screenshot proof permits only the exact remote display, filename and checksum inventory', async t => {
  const scenarios = {
    'extra display set': remote => remote.sets.push({ type: 'appScreenshotSets', id: 'extra-set', attributes: { screenshotDisplayType: 'APP_IPAD_PRO_3GEN_129' } }),
    'duplicate display set': remote => remote.sets.push({ type: 'appScreenshotSets', id: 'duplicate-set', attributes: { screenshotDisplayType: 'APP_IPHONE_67' } }),
    'extra filename': remote => remote.shots.screenshots.push({ type: 'appScreenshots', id: 'extra', attributes: { fileName: 'old-packing.png', sourceFileChecksum: screenshotChecksum, assetDeliveryState: { state: 'COMPLETE' } } }),
    'duplicate filename': remote => remote.shots.screenshots.push({ ...remote.shots.screenshots[0], id: 'duplicate' }),
    'different checksum': remote => { remote.shots.screenshots[0].attributes.sourceFileChecksum = 'different'; },
    'missing checksum': remote => { delete remote.shots.screenshots[0].attributes.sourceFileChecksum; },
  };
  for (const [name, mutate] of Object.entries(scenarios)) {
    await t.test(name, async t => {
      const fixture = await shippingFixture(t, { localScreenshots: true });
      mutate(fixture.remote);
      const snapshot = structuredClone({ sets: fixture.remote.sets, shots: fixture.remote.shots });
      await assert.rejects(fixture.ship(), error => ['APPLE_STATE_MISMATCH', 'APPLE_WRITE_UNCERTAIN'].includes(error.code));
      assert.equal(fixture.remote.created, 0);
      assert.equal(fixture.remote.submitted, 0);
      assert.deepEqual({ sets: fixture.remote.sets, shots: fixture.remote.shots }, snapshot);
      assert.equal(fixture.requests.every(request => request.method === 'GET'), true);
    });
  }
  await t.test('exact inventory', async t => {
    const fixture = await shippingFixture(t, { localScreenshots: true });
    assert.equal((await fixture.ship()).phase, 'submitted');
    assert.equal(fixture.remote.created, 1);
    assert.equal(fixture.remote.submitted, 1);
    assert.equal(fixture.requests.some(request => request.method === 'DELETE'), false);
  });
});

test('an extra remote screenshot appearing during reconciliation still blocks submission', async t => {
  let lists = 0;
  const fixture = await shippingFixture(t, { localScreenshots: true, beforeRequest: (url, options, remote) => {
    if (url.pathname === '/v1/appScreenshotSets/screenshots/appScreenshots' && ++lists === 3) remote.shots.screenshots.push({ type: 'appScreenshots', id: 'unexpected', attributes: { fileName: 'unexpected.png', sourceFileChecksum: screenshotChecksum, assetDeliveryState: { state: 'COMPLETE' } } });
  } });
  await assert.rejects(fixture.ship(), { code: 'APPLE_STATE_MISMATCH' });
  assert.equal(fixture.remote.created, 0);
  assert.equal(fixture.remote.submitted, 0);
  assert.equal(fixture.requests.some(request => request.method === 'DELETE'), false);
});

test('completed assets without a checksum cannot inherit this job’s local screenshot proof', async t => {
  const fixture = await shippingFixture(t, { localScreenshots: true });
  delete fixture.remote.shots.screenshots[0].attributes.sourceFileChecksum;
  fixture.saved.effects = { [`screenshot:APP_IPHONE_67:packing.png:${screenshotChecksum}`]: { id: 'packing' } };
  await assert.rejects(fixture.ship(), { code: 'APPLE_STATE_MISMATCH' });
  assert.equal(fixture.remote.created, 0);
  assert.equal(fixture.remote.submitted, 0);
  assert.equal(fixture.requests.every(request => request.method === 'GET'), true);
});

test('resuming a draft submission rechecks the exact local screenshot inventory without changing assets', async t => {
  for (const extra of [false, true]) {
    await t.test(extra ? 'extra remote asset' : 'matching inventory', async t => {
      const fixture = await shippingFixture(t, { localScreenshots: true });
      fixture.remote.versionState = 'READY_FOR_REVIEW';
      fixture.remote.submissions.push({ type: 'reviewSubmissions', id: 'submission', attributes: { state: 'READY_FOR_REVIEW' } });
      fixture.remote.items.push({ id: 'item', relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: 'version' } } } });
      fixture.saved.submissionId = 'submission';
      if (extra) fixture.remote.shots.screenshots.push({ type: 'appScreenshots', id: 'old', attributes: { fileName: 'old.png', sourceFileChecksum: screenshotChecksum, assetDeliveryState: { state: 'COMPLETE' } } });
      const assets = structuredClone(fixture.remote.shots);
      if (extra) await assert.rejects(fixture.ship(), { code: 'APPLE_STATE_MISMATCH' });
      else assert.equal((await fixture.ship()).phase, 'submitted');
      assert.equal(fixture.remote.created, 0);
      assert.equal(fixture.remote.submitted, extra ? 0 : 1);
      assert.deepEqual(fixture.remote.shots, assets);
      assert.equal(fixture.requests.some(request => request.method !== 'GET' && request.url.pathname.includes('appScreenshot')), false);
    });
  }
});

test('a failed upload intent cannot adopt a competing matching binary', async t => {
  const fixture = await shippingFixture(t, { initialReceipt: {}, uploadExitCode: 1 });
  await assert.rejects(fixture.ship(), { code: 'APPLE_WRITE_UNCERTAIN' });
  assert.equal(fixture.saved.upload.status, 'intent');
  fixture.remote.buildVisible = true;
  fixture.remote.buildId = 'competing-binary';
  const requests = fixture.requests.length;
  await assert.rejects(fixture.ship(), { code: 'APPLE_WRITE_UNCERTAIN' });
  assert.equal(fixture.saved.buildId, undefined);
  assert.equal(fixture.requests.length, requests);
  assert.equal(fixture.remote.uploads, 1);
  assert.equal(fixture.remote.created, 0);
  assert.equal(fixture.remote.submitted, 0);
});

test('legacy reconciled uploads and intents cannot authorize shipping or approval', async t => {
  for (const status of ['intent', 'reconciled']) {
    for (const buildId of [undefined, 'build']) {
      await t.test(`${status}: ${buildId ?? 'unbound'}`, async t => {
        const fixture = await shippingFixture(t, { initialReceipt: { upload: { status }, ...(buildId ? { buildId } : {}) } });
        await assert.rejects(fixture.ship(), { code: 'APPLE_WRITE_UNCERTAIN' });
        await assert.rejects(pollApple({ spec, state: fixture.saved, env: {} }), { code: 'APPLE_WRITE_UNCERTAIN' });
        assert.equal(fixture.requests.length, 0);
      });
    }
  }
});

test('successful delivery receipts and exact known bindings resume without another upload', async t => {
  for (const initialReceipt of [{ upload: { status: 'delivered' } }, { buildId: 'build' }]) {
    await t.test(JSON.stringify(initialReceipt), async t => {
      const fixture = await shippingFixture(t, { initialReceipt });
      assert.equal((await fixture.ship()).phase, 'submitted');
      assert.equal(fixture.saved.buildId, 'build');
      assert.equal(fixture.saved.upload?.status, initialReceipt.upload?.status);
      assert.equal((await fixture.ship()).phase, 'submitted');
      assert.equal(fixture.remote.uploads, 0);
      assert.equal(fixture.remote.submitted, 1);
    });
  }
  await t.test('new successful upload retains delivery provenance', async t => {
    const fixture = await shippingFixture(t, { initialReceipt: {}, uploadExitCode: 0 });
    assert.equal((await fixture.ship()).phase, 'submitted');
    assert.equal(fixture.saved.upload.status, 'delivered');
    assert.equal((await fixture.ship()).phase, 'submitted');
    assert.equal(fixture.remote.uploads, 1);
    assert.equal(fixture.remote.submitted, 1);
  });
});

test('an exact saved build binding cannot drift to a matching replacement build', async t => {
  const fixture = await shippingFixture(t);
  fixture.remote.buildId = 'replacement-build';
  await assert.rejects(fixture.ship(), { code: 'APPLE_STATE_MISMATCH' });
  assert.equal(fixture.saved.buildId, 'build');
  assert.equal(fixture.requests.every(request => request.method === 'GET'), true);
});
