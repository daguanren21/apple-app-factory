import { createHash, randomUUID } from 'node:crypto';
import { lit, obj, union } from '@earendil-works/pi-schema';
import { deliveryManifest, type DeliveryManifest } from './manifest.js';
import {
  MAX_NOTIFICATION_ERROR,
  MAX_NOTIFICATION_MESSAGE_ID,
  MAX_NOTIFICATION_PROVIDER,
  NotificationDeliverySchema,
  NotificationTargetIdSchema,
  type NotificationDelivery,
  type NotificationReceipt,
  type NotificationStatus,
  type NotificationTarget,
} from '../contracts/notification-types.js';
import type { Artifact, Job } from '../contracts/schemas.js';
import { defineContract, nonblankText, uuidSchema, type Contract } from '../contracts/validation.js';
import type { Store } from '../state/store.js';


/**
 * Host-facing handoff for exactly one frozen destination and artifact
 * generation. claimId is present while a send is claimed (and on its
 * idempotent terminal replay). Bound identity is separate from currentArtifact;
 * delivery is null for historical/unknown generations without captured paths.
 */
export type NotificationPacket = {
  jobId: string;
  id: string;
  target: NotificationTarget;
  status: NotificationStatus;
  claimId?: string;
  artifactDigest: string | null;
  artifactCreatedAt: string | null;
  currentArtifact: Pick<Artifact, 'digest' | 'createdAt'>;
  delivery: DeliveryManifest | null;
  subject: string;
  summary: string;
  receipt?: NotificationReceipt;
  error?: string;
};

const hostReceiptSchema = obj({
  provider: nonblankText(MAX_NOTIFICATION_PROVIDER),
  messageId: nonblankText(MAX_NOTIFICATION_MESSAGE_ID),
});
const completeInputSchema = defineContract(union([
  obj({ status: lit('accepted'), receipt: hostReceiptSchema }),
  obj({ status: lit('failed'), reason: nonblankText(MAX_NOTIFICATION_ERROR) }),
  obj({ status: lit('unknown'), reason: nonblankText(MAX_NOTIFICATION_ERROR) }),
]));
const reconcileInputSchema = defineContract(union([
  obj({ status: lit('accepted'), receipt: hostReceiptSchema }),
  obj({ status: lit('not-sent'), reason: nonblankText(MAX_NOTIFICATION_ERROR) }),
]));
const claimIdSchema = defineContract(uuidSchema());

function now(): string {
  return new Date().toISOString();
}

function sameTarget(left: NotificationTarget, right: NotificationTarget): boolean {
  return left.id === right.id && left.channel === right.channel && left.destination === right.destination;
}

function isUncertain(status: NotificationStatus): boolean {
  return status === 'claimed' || status === 'unknown';
}

function entryTime(entry: NotificationDelivery): string {
  return entry.updatedAt ?? entry.completedAt ?? entry.claimedAt ?? entry.createdAt ?? '';
}

function latest(entries: readonly NotificationDelivery[]): NotificationDelivery | undefined {
  let selected: NotificationDelivery | undefined;
  for (const entry of entries) {
    if (!selected || entryTime(entry) >= entryTime(selected)) selected = entry;
  }
  return selected;
}

function entryId(job: Job, target: NotificationTarget, artifact: Artifact): string {
  return createHash('sha256')
    .update(job.id)
    .update('\0')
    .update(artifact.digest)
    .update('\0')
    .update(artifact.createdAt)
    .update('\0')
    .update(target.id)
    .update('\0')
    .update(target.channel)
    .update('\0')
    .update(target.destination)
    .digest('hex');
}

function readyJob(job: Job): asserts job is Job & { artifact: NonNullable<Job['artifact']> } {
  if (job.status !== 'built' || !job.artifact) throw new Error('Notifications require a built task with a recorded artifact');
}

function configuredTargets(job: Job): readonly NotificationTarget[] {
  return job.config.notifications?.targets ?? [];
}

function targetFor(job: Job, targetId: string): NotificationTarget | undefined {
  return configuredTargets(job).find(target => target.id === targetId);
}

function sameArtifact(entry: NotificationDelivery, artifact: Artifact): boolean {
  return entry.artifactDigest === artifact.digest && entry.artifactCreatedAt === artifact.createdAt;
}

function exactEntries(job: Job, target: NotificationTarget, artifact: Artifact): NotificationDelivery[] {
  return job.notifications.filter(entry => sameTarget(entry.target, target) && sameArtifact(entry, artifact));
}

function uncertainEntries(job: Job, target: NotificationTarget): NotificationDelivery[] {
  return job.notifications.filter(entry => entry.target.id === target.id && isUncertain(entry.status));
}

function stateFor(job: Job, target: NotificationTarget, artifact: Artifact): NotificationDelivery | undefined {
  const uncertain = latest(uncertainEntries(job, target));
  if (uncertain) return uncertain;
  return latest(exactEntries(job, target, artifact));
}

function pendingEntry(job: Job, target: NotificationTarget, artifact: Artifact): NotificationDelivery {
  const timestamp = new Date(job.updatedAt).toISOString();
  return NotificationDeliverySchema.parse({
    id: entryId(job, target, artifact),
    target,
    artifactDigest: artifact.digest,
    artifactCreatedAt: artifact.createdAt,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function safePart(value: string, fallback: string): string {
  const cleaned = value.replace(/[\r\n\t]+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 200) : fallback;
}

function packetText(job: Job & { artifact: Artifact }, state: NotificationDelivery, current: boolean): { subject: string; summary: string } {
  if (!current) return {
    subject: '[apphx] Historical artifact notification',
    summary: `Notification for a historical or unverifiable artifact generation of task ${safePart(job.id, 'unknown')}; digest ${state.artifactDigest ?? 'unknown'}; created at ${state.artifactCreatedAt ?? 'unknown'}. No delivery paths are available for this notification.`,
  };
  const name = safePart(job.spec.name, safePart(job.spec.id, 'application'));
  const version = safePart(job.spec.version, 'unknown');
  const artifact = job.artifact;
  return {
    subject: `[apphx] ${name} ${version} packaged`,
    summary: `Verified ${artifact.kind} artifact for ${name} ${version} (${job.spec.platform}/${job.spec.channel}); digest ${artifact.digest}; created at ${artifact.createdAt}.`,
  };
}

function packet(job: Job, state: NotificationDelivery, manifest: DeliveryManifest | null = null): NotificationPacket {
  readyJob(job);
  const current = sameArtifact(state, job.artifact);
  const text = packetText(job, state, current);
  const result: NotificationPacket = {
    jobId: job.id,
    id: state.id,
    target: state.target,
    status: state.status,
    artifactDigest: state.artifactDigest ?? null,
    artifactCreatedAt: state.artifactCreatedAt ?? null,
    currentArtifact: { digest: job.artifact.digest, createdAt: job.artifact.createdAt },
    delivery: current ? manifest ?? deliveryManifest(job) : null,
    subject: text.subject,
    summary: text.summary,
  };
  if (state.claimId) result.claimId = state.claimId;
  if (state.receipt) result.receipt = state.receipt;
  if (state.error) result.error = state.error;
  return result;
}

function packetFor(job: Job, target: NotificationTarget): NotificationPacket {
  readyJob(job);
  const state = stateFor(job, target, job.artifact) ?? pendingEntry(job, target, job.artifact);
  return packet(job, state);
}

function parseTargetId(value: string): string {
  const result = NotificationTargetIdSchema.safeParse(value);
  if (!result.success) throw new Error('Notification target id is invalid');
  return result.data;
}

function parseClaimId(value: string): string {
  const result = claimIdSchema.safeParse(value);
  if (!result.success) throw new Error('Notification claim id is invalid');
  return result.data;
}

function parseInput<T>(schema: Contract<T>, input: unknown, name: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`Invalid notification ${name} input`);
  return result.data;
}

function sameReceipt(left: NotificationReceipt | undefined, right: { provider: string; messageId: string }): boolean {
  return left?.provider === right.provider && left.messageId === right.messageId;
}

/** List only gate-passed jobs with owner-configured, frozen notification targets. */
export function listNotifications(store: Store, jobId?: string): NotificationPacket[] {
  const jobs = jobId === undefined ? store.list() : [store.get(jobId)];
  const packets: NotificationPacket[] = [];
  for (const job of jobs) {
    const targets = configuredTargets(job);
    if (!targets.length || job.status !== 'built' || !job.artifact) continue;
    let manifest: DeliveryManifest | null = null;
    for (const target of targets) {
      const state = stateFor(job, target, job.artifact) ?? pendingEntry(job, target, job.artifact);
      const result = packet(job, state, manifest);
      manifest ??= result.delivery;
      packets.push(result);
    }
  }
  return packets;
}

/** Atomically reserve one exact artifact/destination for a host-side send. */
export function claimNotification(store: Store, jobId: string, targetId: string): NotificationPacket {
  const id = parseTargetId(targetId);
  const updated = store.transition(jobId, current => {
    readyJob(current);
    const target = targetFor(current, id);
    if (!target) throw new Error('Notification target is not configured for this task');
    const artifact = current.artifact;
    const uncertain = latest(uncertainEntries(current, target));
    if (uncertain) throw new Error('Notification is claimed or uncertain; reconcile it before sending again');
    const exact = latest(exactEntries(current, target, artifact));
    if (exact?.status === 'accepted') return {};
    const timestamp = now();
    const claimId = randomUUID();
    const next: NotificationDelivery = exact
      ? NotificationDeliverySchema.parse({ ...exact, status: 'claimed', claimId, claimedAt: timestamp, updatedAt: timestamp, completedAt: undefined, receipt: undefined, error: undefined })
      : NotificationDeliverySchema.parse({ id: entryId(current, target, artifact), target, artifactDigest: artifact.digest, artifactCreatedAt: artifact.createdAt, status: 'claimed', claimId, createdAt: timestamp, updatedAt: timestamp, claimedAt: timestamp });
    const notifications = exact ? current.notifications.map(entry => entry.id === exact.id ? next : entry) : [...current.notifications, next];
    return { notifications };
  });
  const target = targetFor(updated, id);
  if (!target) throw new Error('Notification target disappeared while claiming');
  return packetFor(updated, target);
}

/** Record a host result; uncertain results stay durable and are never reclaimed automatically. */
export function completeNotification(store: Store, jobId: string, claimId: string, input: unknown): NotificationPacket {
  const token = parseClaimId(claimId);
  const result = parseInput(completeInputSchema, input, 'completion');
  let completedId: string | undefined;
  const updated = store.transition(jobId, current => {
    readyJob(current);
    const index = current.notifications.findIndex(entry => entry.claimId === token);
    if (index < 0) throw new Error('Stale or unknown notification claim');
    const existing = current.notifications[index]!;
    completedId = existing.id;
    if (existing.status !== 'claimed') {
      if (existing.status === 'accepted' && result.status === 'accepted' && sameReceipt(existing.receipt, result.receipt)) return {};
      if (existing.status === 'failed' && result.status === 'failed' && existing.error === result.reason) return {};
      if (existing.status === 'unknown' && result.status === 'unknown' && existing.error === result.reason) return {};
      throw new Error('Notification claim has already been completed with a different result');
    }
    if (!sameArtifact(existing, current.artifact)) throw new Error('Notification claim belongs to an older or unknown artifact generation; reconcile it explicitly');
    const timestamp = now();
    const next = result.status === 'accepted'
      ? NotificationDeliverySchema.parse({ ...existing, status: 'accepted', updatedAt: timestamp, completedAt: timestamp, receipt: result.receipt, error: undefined })
      : NotificationDeliverySchema.parse({ ...existing, status: result.status, updatedAt: timestamp, completedAt: timestamp, receipt: undefined, error: result.reason });
    return { notifications: current.notifications.map((entry, entryIndex) => entryIndex === index ? next : entry) };
  });
  const completed = completedId ? updated.notifications.find(entry => entry.id === completedId) : undefined;
  if (!completed) throw new Error('Completed notification state disappeared');
  return packet(updated, completed);
}

/** Resolve an uncertain/orphaned host outcome without initiating another send. */
export function reconcileNotification(store: Store, jobId: string, targetId: string, input: unknown): NotificationPacket {
  const id = parseTargetId(targetId);
  const result = parseInput(reconcileInputSchema, input, 'reconciliation');
  let reconciledId: string | undefined;
  const updated = store.transition(jobId, current => {
    readyJob(current);
    const target = targetFor(current, id);
    if (!target) throw new Error('Notification target is not configured for this task');
    const candidate = latest(current.notifications.filter(entry => entry.target.id === id && isUncertain(entry.status)));
    if (candidate) {
      reconciledId = candidate.id;
      const timestamp = now();
      const next = result.status === 'accepted'
        ? NotificationDeliverySchema.parse({ ...candidate, status: 'accepted', claimId: undefined, updatedAt: timestamp, completedAt: timestamp, receipt: result.receipt, error: undefined })
        : NotificationDeliverySchema.parse({ ...candidate, status: 'failed', claimId: undefined, updatedAt: timestamp, completedAt: timestamp, receipt: undefined, error: result.reason });
      return { notifications: current.notifications.map(entry => entry.id === candidate.id ? next : entry) };
    }
    const acceptedHistory = latest(current.notifications.filter(entry => entry.target.id === id && entry.status === 'accepted'));
    if (acceptedHistory && result.status === 'accepted' && sameReceipt(acceptedHistory.receipt, result.receipt)) {
      reconciledId = acceptedHistory.id;
      return {};
    }
    const failedHistory = latest(current.notifications.filter(entry => entry.target.id === id && entry.status === 'failed'));
    if (failedHistory && result.status === 'not-sent' && failedHistory.error === result.reason) {
      reconciledId = failedHistory.id;
      return {};
    }
    throw new Error('No claimed or uncertain notification requires reconciliation');
  });
  const reconciled = reconciledId ? updated.notifications.find(entry => entry.id === reconciledId) : undefined;
  if (!reconciled) throw new Error('Reconciled notification state disappeared');
  return packet(updated, reconciled);
}
