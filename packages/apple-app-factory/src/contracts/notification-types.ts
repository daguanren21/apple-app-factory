import { arr, lit, nullable, obj, oneOf, opt, str } from '@earendil-works/pi-schema';
import { defineContract, isoDateTimeSchema, nonblankText, uuidSchema, type Parsed } from './validation.js';

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


export const NotificationTargetIdSchema = defineContract(nonblankText(MAX_NOTIFICATION_ID));
export const NotificationChannelSchema = defineContract(nonblankText(MAX_NOTIFICATION_TEXT));
export const NotificationDestinationSchema = defineContract(nonblankText(MAX_NOTIFICATION_TEXT));

export const NotificationTargetSchema = defineContract(obj({
  id: NotificationTargetIdSchema.schema,
  channel: NotificationChannelSchema.schema,
  destination: NotificationDestinationSchema.schema,
}));
export type NotificationTarget = Parsed<typeof NotificationTargetSchema>;

export const NotificationConfigSchema = defineContract(obj({
  targets: arr(NotificationTargetSchema.schema, { maxItems: MAX_NOTIFICATION_TARGETS }),
}), { check(value, issue) {
  const ids = new Set<string>();
  for (const [index, target] of value.targets.entries()) {
    if (ids.has(target.id)) issue(['targets', index, 'id'], 'Notification target ids must be unique');
    ids.add(target.id);
  }
} });
export type NotificationConfig = Parsed<typeof NotificationConfigSchema>;

export const NotificationStatusSchema = defineContract(oneOf(['pending', 'claimed', 'accepted', 'failed', 'unknown']));
export type NotificationStatus = Parsed<typeof NotificationStatusSchema>;

/**
 * A legacy receipt is allowed only as an explicitly marked historical record.
 * New host receipts are checked again at the notify boundary and must include
 * a provider message id.
 */
export const NotificationReceiptSchema = defineContract(obj({
  provider: nonblankText(MAX_NOTIFICATION_PROVIDER),
  messageId: opt(nonblankText(MAX_NOTIFICATION_MESSAGE_ID)),
  legacy: opt(lit(true)),
}), { check(value, issue) {
  if (!value.messageId && value.legacy !== true) issue(['messageId'], 'A non-legacy receipt requires a provider message id');
} });
export type NotificationReceipt = Parsed<typeof NotificationReceiptSchema>;

const digest = str({ pattern: '^[a-f0-9]{64}$' });
const timestamp = isoDateTimeSchema(128);

/**
 * One durable destination/artifact state. The digest and artifactCreatedAt
 * identify bytes and the packaging event separately. Missing legacy binding
 * components remain unknown; notification timestamps cannot establish them.
 */
export const NotificationDeliverySchema = defineContract(obj({
  id: nonblankText(MAX_NOTIFICATION_ID),
  target: NotificationTargetSchema.schema,
  artifactDigest: opt(nullable(digest)),
  artifactCreatedAt: opt(nullable(timestamp)),
  status: NotificationStatusSchema.schema,
  claimId: opt(uuidSchema()),
  createdAt: opt(timestamp),
  updatedAt: opt(timestamp),
  claimedAt: opt(timestamp),
  completedAt: opt(timestamp),
  receipt: opt(NotificationReceiptSchema.schema),
  error: opt(nonblankText(MAX_NOTIFICATION_ERROR)),
}), { check(value, issue) {
  if (value.status === 'claimed' && !value.claimId) issue(['claimId'], 'A claimed notification requires a claim id');
  if (value.status === 'accepted' && !value.receipt) issue(['receipt'], 'An accepted notification requires a receipt');
  if ((value.status === 'failed' || value.status === 'unknown') && !value.error) issue(['error'], 'A failed or uncertain notification requires a reason');
  if (value.status !== 'accepted' && value.receipt) issue(['receipt'], 'Only accepted notifications may carry a receipt');
  if (value.status === 'pending' && value.claimId) issue(['claimId'], 'A pending notification cannot carry a claim id');
} });
export type NotificationDelivery = Parsed<typeof NotificationDeliverySchema>;
