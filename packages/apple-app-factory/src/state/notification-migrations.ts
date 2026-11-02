import { createHash } from 'node:crypto';
import { MAX_NOTIFICATION_ERROR, NotificationDeliverySchema, type NotificationDelivery, type NotificationStatus, type NotificationTarget } from '../contracts/notification-types.js';

function legacyText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function legacyTimestamp(value: unknown): string | undefined {
  const text = legacyText(value, 128);
  if (!text) return undefined;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Migrate v3 notification history in place; this never creates active targets or message ids. */
export function migrateNotifications(saved: Record<string, unknown>): void {
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Saved notification state must be an object');
  const configValue = saved.config;
  const config = typeof configValue === 'object' && configValue !== null && !Array.isArray(configValue)
    ? configValue as Record<string, unknown>
    : undefined;
  if (config && Object.prototype.hasOwnProperty.call(config, 'notify')) delete config.notify;
  if (Object.prototype.hasOwnProperty.call(saved, 'notify')) delete saved.notify;

  const notifications: NotificationDelivery[] = [];
  if (saved.notifications !== undefined) {
    if (!Array.isArray(saved.notifications)) throw new Error('Saved notifications must be an array');
    for (const value of saved.notifications) {
      const parsed = NotificationDeliverySchema.safeParse(value);
      if (!parsed.success) throw new Error('Saved notification history is invalid');
      notifications.push(parsed.data);
    }
  }

  const notifiedAt = legacyTimestamp(saved.notifiedAt);
  const notifiedTo = legacyText(saved.notifiedTo, 2048);
  const sendingAt = legacyTimestamp(saved.notifySendingAt);
  const notifyError = legacyText(saved.notifyError, MAX_NOTIFICATION_ERROR);
  const accepted = Boolean(notifiedAt);
  const uncertain = !accepted && Boolean(sendingAt || saved.notifySendingAt || saved.notifiedAt || notifiedTo && !notifyError);
  const failed = !accepted && !uncertain && Boolean(notifyError);
  if (accepted || uncertain || failed) {
    const destination = notifiedTo ?? 'legacy:unknown';
    const target: NotificationTarget = {
      id: `legacy-email-${createHash('sha256').update(destination).digest('hex').slice(0, 24)}`,
      channel: 'email',
      destination,
    };
    const status: NotificationStatus = accepted ? 'accepted' : uncertain ? 'unknown' : 'failed';
    const at = notifiedAt ?? sendingAt;
    const historicalError = uncertain
      ? 'Legacy notification may have been sent; reconcile before sending again'
      : failed
        ? `Legacy notification failed${notifyError ? `: ${notifyError}` : ''}`.slice(0, MAX_NOTIFICATION_ERROR)
        : undefined;
    const historical: NotificationDelivery = NotificationDeliverySchema.parse({
      id: `legacy-${createHash('sha256').update(String(saved.id ?? '')).update('\0').update(destination).update('\0').update(status).digest('hex').slice(0, 56)}`,
      target,
      artifactDigest: null,
      artifactCreatedAt: null,
      status,
      createdAt: at,
      updatedAt: at,
      receipt: accepted ? { provider: 'legacy', legacy: true } : undefined,
      error: historicalError,
    });
    if (!notifications.some(entry => entry.id === historical.id)) notifications.push(historical);
  }

  delete saved.notifiedAt;
  delete saved.notifiedTo;
  delete saved.notifySendingAt;
  delete saved.notifyError;
  if (notifications.length) saved.notifications = notifications;
  else delete saved.notifications;
}
