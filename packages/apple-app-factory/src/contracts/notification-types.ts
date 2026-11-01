import { z } from 'zod';

/**
 * Notification configuration is deliberately small: the host owns transport
 * capabilities and this queue only freezes opaque destinations for it. A
 * specification authorEmail is never promoted into an active target.
 */
export const MAX_NOTIFICATION_TARGETS = 32;
export const MAX_NOTIFICATION_ID = 128;
export const MAX_NOTIFICATION_TEXT = 2048;
export const MAX_NOTIFICATION_ERROR = 4096;
export const MAX_NOTIFICATION_PROVIDER = 128;
export const MAX_NOTIFICATION_MESSAGE_ID = 512;

function text(max: number) {
  return z.string().min(1).max(max).refine(value => value.trim().length > 0 && !value.includes('\0'), 'Expected non-empty text without NUL characters');
}

export const NotificationTargetIdSchema = text(MAX_NOTIFICATION_ID);
export const NotificationChannelSchema = text(MAX_NOTIFICATION_TEXT);
export const NotificationDestinationSchema = text(MAX_NOTIFICATION_TEXT);

export const NotificationTargetSchema = z.strictObject({
  id: NotificationTargetIdSchema,
  channel: NotificationChannelSchema,
  destination: NotificationDestinationSchema,
});
export type NotificationTarget = z.infer<typeof NotificationTargetSchema>;

export const NotificationConfigSchema = z.strictObject({
  targets: z.array(NotificationTargetSchema).max(MAX_NOTIFICATION_TARGETS),
}).superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, target] of value.targets.entries()) {
    if (ids.has(target.id)) context.addIssue({ code: 'custom', path: ['targets', index, 'id'], message: 'Notification target ids must be unique' });
    ids.add(target.id);
  }
});
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

export const NotificationStatusSchema = z.enum(['pending', 'claimed', 'accepted', 'failed', 'unknown']);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

/**
 * A legacy receipt is allowed only as an explicitly marked historical record.
 * New host receipts are checked again at the notify boundary and must include
 * a provider message id.
 */
export const NotificationReceiptSchema = z.strictObject({
  provider: text(MAX_NOTIFICATION_PROVIDER),
  messageId: text(MAX_NOTIFICATION_MESSAGE_ID).optional(),
  legacy: z.literal(true).optional(),
}).superRefine((value, context) => {
  if (!value.messageId && value.legacy !== true) context.addIssue({ code: 'custom', path: ['messageId'], message: 'A non-legacy receipt requires a provider message id' });
});
export type NotificationReceipt = z.infer<typeof NotificationReceiptSchema>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime().max(128);

/**
 * One durable destination/artifact state. The digest and artifactCreatedAt
 * identify bytes and the packaging event separately. Missing legacy binding
 * components remain unknown; notification timestamps cannot establish them.
 */
export const NotificationDeliverySchema = z.strictObject({
  id: text(MAX_NOTIFICATION_ID),
  target: NotificationTargetSchema,
  artifactDigest: digest.nullable().optional(),
  artifactCreatedAt: timestamp.nullable().optional(),
  status: NotificationStatusSchema,
  claimId: z.uuid().optional(),
  createdAt: timestamp.optional(),
  updatedAt: timestamp.optional(),
  claimedAt: timestamp.optional(),
  completedAt: timestamp.optional(),
  receipt: NotificationReceiptSchema.optional(),
  error: text(MAX_NOTIFICATION_ERROR).optional(),
}).superRefine((value, context) => {
  if (value.status === 'claimed' && !value.claimId) context.addIssue({ code: 'custom', path: ['claimId'], message: 'A claimed notification requires a claim id' });
  if (value.status === 'accepted' && !value.receipt) context.addIssue({ code: 'custom', path: ['receipt'], message: 'An accepted notification requires a receipt' });
  if ((value.status === 'failed' || value.status === 'unknown') && !value.error) context.addIssue({ code: 'custom', path: ['error'], message: 'A failed or uncertain notification requires a reason' });
  if (value.status !== 'accepted' && value.receipt) context.addIssue({ code: 'custom', path: ['receipt'], message: 'Only accepted notifications may carry a receipt' });
  if (value.status === 'pending' && value.claimId) context.addIssue({ code: 'custom', path: ['claimId'], message: 'A pending notification cannot carry a claim id' });
});
export type NotificationDelivery = z.infer<typeof NotificationDeliverySchema>;
