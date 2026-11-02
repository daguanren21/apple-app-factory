import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../dist/contracts/schemas.js';
import { Store } from '../dist/state/store.js';
import {
  claimNotification,
  completeNotification,
  listNotifications,
  reconcileNotification,
} from '../dist/delivery/notifications.js';
import { NotificationConfigSchema, NotificationDeliverySchema, NotificationReceiptSchema, NotificationTargetIdSchema } from '../dist/contracts/notification-types.js';
import { migrateNotifications } from '../dist/state/notification-migrations.js';

const success = [process.execPath, '-e', 'process.exit(0)'];
const digest = 'a'.repeat(64);
const artifactCreatedAt = '2026-01-01T00:00:00.000Z';
const nextCreatedAt = '2026-01-02T00:00:00.000Z';

function target(id, destination = `${id}@owner.invalid`) {
  return { id, channel: 'host-mail', destination };
}

function fixture(t, targets) {
  const base = mkdtempSync(join(tmpdir(), 'factory-notify-'));
  const projectRoot = join(base, 'project');
  mkdirSync(projectRoot);
  const config = ConfigSchema.parse({
    stateDir: join(base, 'state'),
    workspaceRoot: join(base, 'workspaces'),
    projectMode: 'project',
    projectRoot,
    packageTarget: 'simulator',
    allowLocalExecution: true,
    executionEnv: ['IOS_DEVICE_ID'],
    verification: { prerequisites: [], checks: [success], runtime: [success] },
    ...(targets === undefined ? {} : { notifications: { targets } }),
  });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(base, { recursive: true, force: true }); });
  const built = (name, specExtra = {}, patch = {}) => {
    const job = store.enqueue({
      id: `notify-${name}`,
      name: `Notify ${name}`,
      framework: 'flutter',
      platform: 'ios',
      channel: 'local',
      version: '1.0.0',
      purpose: `Exercise ${name}`,
      audience: 'Factory maintainers',
      differentiators: ['Durable host notification'],
      acceptance: ['Preserve notification proof'],
      ...specExtra,
    }, config);
    return store.update(job.id, {
      status: 'built',
      verifiedDigest: digest,
      artifact: { kind: 'ios-simulator', path: join(projectRoot, 'build', 'App.app'), digest, createdAt: artifactCreatedAt },
      ...patch,
    });
  };
  return { base, config, store, built };
}

function packetFor(store, jobId, targetId) {
  return listNotifications(store, jobId).find(packet => packet.target.id === targetId);
}

function assertHistorical(packet, boundArtifact, currentArtifact) {
  assert.equal(packet.artifactDigest, boundArtifact.digest);
  assert.equal(packet.artifactCreatedAt, boundArtifact.createdAt);
  assert.deepEqual(packet.currentArtifact, { digest: currentArtifact.digest, createdAt: currentArtifact.createdAt });
  assert.equal(packet.delivery, null);
  assert.match(packet.subject, /historical/i);
  assert.equal(packet.summary.includes(boundArtifact.digest ?? 'unknown'), true);
  assert.equal(packet.summary.includes(boundArtifact.createdAt ?? 'unknown'), true);
  assert.doesNotMatch(packet.summary, /Verified|packaged/);
  assert.equal(JSON.stringify(packet).includes(currentArtifact.path), false);
  if (boundArtifact.digest !== currentArtifact.digest) assert.equal(packet.summary.includes(currentArtifact.digest), false);
  if (boundArtifact.createdAt !== currentArtifact.createdAt) assert.equal(packet.summary.includes(currentArtifact.createdAt), false);
}

test('absent notification targets are a read-only no-op', t => {
  const f = fixture(t, undefined);
  const job = f.built('absent', { authorEmail: 'author@example.invalid' });
  assert.deepEqual(listNotifications(f.store, job.id), []);
  assert.deepEqual(listNotifications(f.store), []);
});

test('notifications list only built artifacts and uses the frozen target, not authorEmail', t => {
  const f = fixture(t, [target('owner', 'owner@host.invalid')]);
  const queued = f.store.enqueue({
    id: 'notify-queued', name: 'Queued', framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0',
    purpose: 'Queue only', audience: 'Maintainers', differentiators: ['No artifact'], acceptance: ['No notification'], authorEmail: 'attacker@unapproved.invalid',
  }, f.config);
  assert.deepEqual(listNotifications(f.store, queued.id), []);
  const built = f.built('frozen', { authorEmail: 'attacker@unapproved.invalid' });
  const packet = packetFor(f.store, built.id, 'owner');
  assert.ok(packet);
  assert.equal(packet.target.destination, 'owner@host.invalid');
  assert.equal(packet.status, 'pending');
  assert.equal(packet.artifactDigest, built.artifact.digest);
  assert.equal(packet.artifactCreatedAt, built.artifact.createdAt);
  assert.deepEqual(packet.currentArtifact, { digest, createdAt: artifactCreatedAt });
  assert.deepEqual(packet.delivery.artifact, built.artifact);
  assert.equal(packet.delivery.projectRoot, built.projectRoot);
  assert.equal(packet.delivery.runtime.environment.includes('IOS_DEVICE_ID'), true);
  assert.throws(() => claimNotification(f.store, built.id, 'attacker@unapproved.invalid'), /not configured/i);
  assert.throws(() => f.store.update(built.id, { config: { ...built.config, notifications: { targets: [target('owner', 'attacker@unapproved.invalid')] } } }), /frozen/i);
});

test('claim and duplicate accepted completion are idempotent', t => {
  const f = fixture(t, [target('owner')]);
  const job = f.built('accepted');
  const pending = packetFor(f.store, job.id, 'owner');
  assert.deepEqual(packetFor(f.store, job.id, 'owner'), pending);
  assert.deepEqual(f.store.get(job.id).notifications, []);
  const claimed = claimNotification(f.store, job.id, 'owner');
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.id, pending.id);
  assert.equal(claimed.artifactCreatedAt, job.artifact.createdAt);
  assert.match(claimed.claimId, /^[0-9a-f-]{36}$/);
  const receipt = { provider: 'host-mail', messageId: 'host-accepted-1' };
  const accepted = completeNotification(f.store, job.id, claimed.claimId, { status: 'accepted', receipt });
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.receipt, receipt);
  const before = f.store.get(job.id).notifications;
  const replay = completeNotification(f.store, job.id, claimed.claimId, { status: 'accepted', receipt });
  assert.deepEqual(replay, accepted);
  assert.deepEqual(claimNotification(f.store, job.id, 'owner'), accepted);
  assert.deepEqual(packetFor(f.store, job.id, 'owner'), accepted);
  assert.deepEqual(f.store.get(job.id).notifications, before);
  assert.throws(() => completeNotification(f.store, job.id, claimed.claimId, { status: 'accepted', receipt: { provider: 'host-mail', messageId: 'different' } }), /different result/i);
  assert.equal(f.store.get(job.id).status, 'built');
});

test('target claims are independent and uncertain sends require reconciliation', t => {
  const f = fixture(t, [target('one'), target('two')]);
  const job = f.built('independent');
  const one = claimNotification(f.store, job.id, 'one');
  const uncertain = completeNotification(f.store, job.id, one.claimId, { status: 'unknown', reason: 'Host exited after handing off the send' });
  assert.equal(uncertain.status, 'unknown');
  assert.deepEqual(completeNotification(f.store, job.id, one.claimId, { status: 'unknown', reason: 'Host exited after handing off the send' }), uncertain);
  assert.equal(f.store.get(job.id).notifications.length, 1);
  assert.throws(() => claimNotification(f.store, job.id, 'one'), /uncertain|reconcile/i);
  const two = claimNotification(f.store, job.id, 'two');
  assert.equal(two.status, 'claimed');
  const failed = reconcileNotification(f.store, job.id, 'one', { status: 'not-sent', reason: 'Host confirmed no send occurred' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.claimId, undefined);
  assert.deepEqual(reconcileNotification(f.store, job.id, 'one', { status: 'not-sent', reason: 'Host confirmed no send occurred' }), failed);
  const retry = claimNotification(f.store, job.id, 'one');
  assert.equal(retry.status, 'claimed');
  assert.equal(retry.id, one.id);
  assert.notEqual(retry.claimId, one.claimId);
  assert.equal(packetFor(f.store, job.id, 'two').status, 'claimed');
  assert.equal(f.store.get(job.id).status, 'built');
});

test('a second store sees the durable claim and refuses a sequential duplicate', t => {
  const f = fixture(t, [target('race')]);
  const other = new Store(f.config.stateDir);
  t.after(() => other.close());
  const job = f.built('race');
  const winner = claimNotification(f.store, job.id, 'race');
  assert.equal(winner.status, 'claimed');
  assert.throws(() => claimNotification(other, job.id, 'race'), /claimed|uncertain/i);
  const states = listNotifications(f.store, job.id);
  assert.equal(states.length, 1);
  assert.equal(states[0].claimId, winner.claimId);
});

test('completion and reconciliation inputs are strict and failures do not alter built status', t => {
  const f = fixture(t, [target('strict')]);
  const job = f.built('strict');
  const claim = claimNotification(f.store, job.id, 'strict');
  assert.throws(() => completeNotification(f.store, job.id, claim.claimId, { status: 'accepted' }), /invalid/i);
  assert.throws(() => completeNotification(f.store, job.id, claim.claimId, { status: 'accepted', receipt: { provider: 'host', messageId: 'x' }, secret: 'do-not-forward' }), /invalid/i);
  assert.throws(() => completeNotification(f.store, job.id, claim.claimId, { status: 'unknown' }), /invalid/i);
  assert.throws(() => reconcileNotification(f.store, job.id, 'strict', { status: 'not-sent' }), /invalid/i);
  assert.equal(f.store.get(job.id).status, 'built');
  const failed = completeNotification(f.store, job.id, claim.claimId, { status: 'failed', reason: 'Host capability unavailable; confirmed unsent' });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(completeNotification(f.store, job.id, claim.claimId, { status: 'failed', reason: 'Host capability unavailable; confirmed unsent' }), failed);
  assert.equal(f.store.get(job.id).notifications.length, 1);
  assert.equal(f.store.get(job.id).status, 'built');
});

test('reconciliation can accept an uncertain send without initiating another claim', t => {
  const f = fixture(t, [target('recover')]);
  const job = f.built('recover');
  const claim = claimNotification(f.store, job.id, 'recover');
  completeNotification(f.store, job.id, claim.claimId, { status: 'unknown', reason: 'Host crashed before its receipt was saved' });
  const reconciled = reconcileNotification(f.store, job.id, 'recover', { status: 'accepted', receipt: { provider: 'host-mail', messageId: 'recovered-1' } });
  assert.equal(reconciled.status, 'accepted');
  assert.deepEqual(reconciled.receipt, { provider: 'host-mail', messageId: 'recovered-1' });
  const before = f.store.get(job.id).notifications;
  const repeated = claimNotification(f.store, job.id, 'recover');
  assert.equal(repeated.status, 'accepted');
  assert.equal(repeated.claimId, undefined);
  assert.deepEqual(f.store.get(job.id).notifications, before);
});

for (const nextDigest of [digest, 'b'.repeat(64)]) {
  for (const status of ['claimed', 'unknown']) {
    test(`${status} old generation stays bound while ${nextDigest === digest ? 'byte-identical' : 'different'} artifact replaces it`, t => {
      const f = fixture(t, [target('generation')]);
      const job = f.built('generation');
      const claim = claimNotification(f.store, job.id, 'generation');
      if (status === 'unknown') completeNotification(f.store, job.id, claim.claimId, { status: 'unknown', reason: 'Host exited before reporting the outcome' });
      const nextArtifact = { ...job.artifact, path: join(f.base, 'project', 'build', 'App-new.app'), digest: nextDigest, createdAt: nextCreatedAt };
      f.store.update(job.id, { verifiedDigest: nextDigest, artifact: nextArtifact });

      const listed = packetFor(f.store, job.id, 'generation');
      assert.equal(listed.id, claim.id);
      assert.equal(listed.claimId, claim.claimId);
      assert.equal(listed.status, status);
      assertHistorical(listed, job.artifact, nextArtifact);
      assert.throws(() => claimNotification(f.store, job.id, 'generation'), /claimed|uncertain/i);
      assert.throws(() => completeNotification(f.store, job.id, claim.claimId, { status: 'accepted', receipt: { provider: 'host', messageId: 'stale' } }), /older|unknown artifact|different result/i);
      const result = status === 'claimed'
        ? { status: 'not-sent', reason: 'Host confirmed the older generation was not sent' }
        : { status: 'accepted', receipt: { provider: 'host', messageId: 'recovered-old-generation' } };
      const reconciled = reconcileNotification(f.store, job.id, 'generation', result);
      assert.equal(reconciled.status, status === 'claimed' ? 'failed' : 'accepted');
      assert.equal(reconciled.id, claim.id);
      assert.equal(reconciled.claimId, undefined);
      assert.deepEqual(reconciled.receipt, result.receipt);
      assertHistorical(reconciled, job.artifact, nextArtifact);
      assert.deepEqual(reconcileNotification(f.store, job.id, 'generation', result), reconciled);

      const pending = packetFor(f.store, job.id, 'generation');
      assert.equal(pending.status, 'pending');
      assert.notEqual(pending.id, claim.id);
      assert.equal(pending.artifactDigest, nextDigest);
      assert.equal(pending.artifactCreatedAt, nextCreatedAt);
      assert.deepEqual(pending.delivery.artifact, nextArtifact);
      assert.equal(pending.receipt, undefined);
      const next = claimNotification(f.store, job.id, 'generation');
      assert.equal(next.status, 'claimed');
      assert.equal(next.id, pending.id);
      assert.notEqual(next.claimId, claim.claimId);
      const saved = f.store.get(job.id);
      assert.equal(saved.status, 'built');
      assert.deepEqual(saved.artifact, nextArtifact);
      assert.equal(saved.verifiedDigest, nextDigest);
      assert.equal(saved.notifications.length, 2);
      assert.equal(saved.notifications[0].artifactDigest, job.artifact.digest);
      assert.equal(saved.notifications[0].artifactCreatedAt, job.artifact.createdAt);
    });
  }
}

test('byte-identical repackaging is pending and old accepted completion replays only its bound identity', t => {
  const f = fixture(t, [target('repackaged')]);
  const job = f.built('repackaged');
  const claimed = claimNotification(f.store, job.id, 'repackaged');
  const result = { status: 'accepted', receipt: { provider: 'host', messageId: 'first-packaging' } };
  completeNotification(f.store, job.id, claimed.claimId, result);
  const nextArtifact = { ...job.artifact, createdAt: nextCreatedAt };
  f.store.update(job.id, { artifact: nextArtifact });
  const pending = packetFor(f.store, job.id, 'repackaged');
  assert.equal(pending.status, 'pending');
  assert.notEqual(pending.id, claimed.id);
  assert.equal(pending.artifactDigest, digest);
  assert.equal(pending.artifactCreatedAt, nextCreatedAt);
  assert.deepEqual(pending.delivery.artifact, nextArtifact);
  assert.equal(pending.receipt, undefined);
  const replay = completeNotification(f.store, job.id, claimed.claimId, result);
  assert.equal(replay.id, claimed.id);
  assert.equal(replay.status, 'accepted');
  assert.deepEqual(replay.receipt, result.receipt);
  assertHistorical(replay, job.artifact, nextArtifact);
  assert.deepEqual(packetFor(f.store, job.id, 'repackaged'), pending);
  const nextClaim = claimNotification(f.store, job.id, 'repackaged');
  assert.equal(nextClaim.status, 'claimed');
  assert.equal(nextClaim.id, pending.id);
  assert.notEqual(nextClaim.claimId, claimed.claimId);
  assert.equal(nextClaim.receipt, undefined);
  assert.equal(f.store.get(job.id).status, 'built');
});

test('digest-only legacy claims remain unknown even when current artifact bytes match', t => {
  const f = fixture(t, [target('legacy')]);
  const job = f.built('legacy');
  const claimed = claimNotification(f.store, job.id, 'legacy');
  const historical = { ...f.store.get(job.id).notifications[0], id: 'digest-only-history' };
  delete historical.artifactCreatedAt;
  f.store.update(job.id, { notifications: [historical] });
  const reopened = new Store(f.config.stateDir);
  t.after(() => reopened.close());
  const listed = packetFor(reopened, job.id, 'legacy');
  assert.equal(listed.id, historical.id);
  assert.equal(listed.claimId, claimed.claimId);
  assertHistorical(listed, { digest, createdAt: null }, job.artifact);
  assert.throws(() => claimNotification(reopened, job.id, 'legacy'), /claimed|uncertain/i);
  assert.throws(() => completeNotification(reopened, job.id, claimed.claimId, { status: 'accepted', receipt: { provider: 'host', messageId: 'unproven' } }), /unknown artifact|reconcile/i);
  const result = { status: 'accepted', receipt: { provider: 'host', messageId: 'legacy-confirmed' } };
  const reconciled = reconcileNotification(reopened, job.id, 'legacy', result);
  assert.equal(reconciled.status, 'accepted');
  assertHistorical(reconciled, { digest, createdAt: null }, job.artifact);
  const pending = packetFor(reopened, job.id, 'legacy');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.artifactCreatedAt, artifactCreatedAt);
  assert.equal(pending.receipt, undefined);
  assert.notEqual(pending.id, historical.id);
  assert.equal(claimNotification(reopened, job.id, 'legacy').status, 'claimed');
  assert.equal(reopened.get(job.id).status, 'built');
});

test('legacy migration preserves history without fabricating message ids or active targets', () => {
  const saved = {
    id: 'legacy-job',
    notifiedAt: '2026-01-01T00:00:00.000Z',
    notifiedTo: 'legacy@example.invalid',
    config: { notify: { email: { to: 'legacy@example.invalid' } } },
    artifact: { digest: 'b'.repeat(64), createdAt: nextCreatedAt },
  };
  migrateNotifications(saved);
  assert.equal('notifiedAt' in saved, false);
  assert.equal('notifiedTo' in saved, false);
  assert.equal('notify' in saved.config, false);
  assert.equal(saved.config.notifications, undefined);
  assert.equal(saved.notifications.length, 1);
  assert.equal(saved.notifications[0].status, 'accepted');
  assert.equal(saved.notifications[0].receipt.provider, 'legacy');
  assert.equal(saved.notifications[0].receipt.legacy, true);
  assert.equal('messageId' in saved.notifications[0].receipt, false);
  assert.equal(saved.notifications[0].artifactDigest, null);
  assert.equal(saved.notifications[0].artifactCreatedAt, null);

  const uncertain = { id: 'legacy-uncertain', notifySendingAt: '2026-01-01T00:00:00.000Z', notifiedTo: 'legacy@example.invalid' };
  migrateNotifications(uncertain);
  assert.equal(uncertain.notifications[0].status, 'unknown');
  assert.equal(uncertain.notifications[0].receipt, undefined);
  assert.equal(uncertain.notifications[0].artifactDigest, null);
  assert.equal(uncertain.notifications[0].artifactCreatedAt, null);

  const missingReceipt = { id: 'legacy-recipient-only', notifiedTo: 'legacy@example.invalid' };
  migrateNotifications(missingReceipt);
  assert.equal(missingReceipt.notifications[0].status, 'unknown');
  assert.equal(missingReceipt.notifications[0].receipt, undefined);
});

test('notification target schema rejects duplicate, unbounded and unsafe text', () => {
  assert.equal(NotificationConfigSchema.safeParse({ targets: [target('same'), target('same')] }).success, false);
  assert.equal(NotificationConfigSchema.safeParse({ targets: [{ ...target('nul'), destination: 'a\0b' }] }).success, false);
  assert.equal(NotificationConfigSchema.safeParse({ targets: Array.from({ length: 33 }, (_, index) => target(`t${index}`)) }).success, false);
  assert.equal(NotificationConfigSchema.safeParse({ targets: [target('strict', 'a'), { ...target('other'), extra: 'reject' }] }).success, false);
});

test('notification text limits count Unicode code points and reject coercion', () => {
  const id = '😀'.repeat(128);
  assert.equal(NotificationTargetIdSchema.parse(id), id);
  for (const value of ['😀'.repeat(129), 123, null, ' ', 'a\0b']) {
    assert.equal(NotificationTargetIdSchema.safeParse(value).success, false);
  }
});

test('legacy receipts and delivery state checks remain enforced at nested parsing boundaries', t => {
  assert.deepEqual(NotificationReceiptSchema.parse({ provider: 'legacy', legacy: true }), { provider: 'legacy', legacy: true });
  assert.equal(NotificationReceiptSchema.safeParse({ provider: 'host' }).success, false);
  assert.equal(NotificationReceiptSchema.safeParse({ provider: 'host', legacy: false }).success, false);
  const f = fixture(t, [target('nested')]);
  const job = f.built('nested');
  const entry = { id: 'historical', target: target('nested'), artifactDigest: null, artifactCreatedAt: null, status: 'accepted', receipt: { provider: 'legacy', legacy: true } };
  assert.deepEqual(NotificationDeliverySchema.parse(entry), entry);
  assert.deepEqual(f.store.update(job.id, { notifications: [entry] }).notifications, [entry]);
  for (const patch of [
    { receipt: { provider: 'host' } },
    { receipt: undefined },
    { status: 'pending' },
    { status: 'claimed', receipt: undefined },
    { status: 'failed', receipt: undefined },
    { status: 'unknown', receipt: undefined },
    { artifactDigest: digest.toUpperCase() },
  ]) {
    assert.equal(NotificationDeliverySchema.safeParse({ ...entry, ...patch }).success, false);
    assert.throws(() => f.store.update(job.id, { notifications: [{ ...entry, ...patch }] }));
  }
});
