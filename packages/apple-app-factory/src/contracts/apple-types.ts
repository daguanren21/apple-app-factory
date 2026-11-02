import { bool, int, map, nullable, obj, oneOf, opt, str } from '@earendil-works/pi-schema';
import { defineContract, isoDateTimeSchema, type Parsed } from './validation.js';

const text = str({ minLength: 1 });
const effect = obj({ id: opt(text) });

export const AppleReceiptSchema = defineContract(obj({
  identity: opt(obj({ appId: text, bundleId: text, version: text, buildNumber: text })),
  pending: opt(nullable(obj({ key: text, path: opt(text), method: opt(oneOf(['POST', 'PATCH', 'PUT'])), startedAt: opt(isoDateTimeSchema()) }))),
  effects: opt(map(effect)),
  lastEffect: opt(obj({ key: text, id: opt(text), reconciled: opt(bool()), completedAt: opt(isoDateTimeSchema()) })),
  upload: opt(obj({ status: oneOf(['intent', 'delivered', 'reconciled']), startedAt: opt(isoDateTimeSchema()) })),
  phase: opt(oneOf(['processing', 'submitted'])),
  versionId: opt(text),
  buildId: opt(text),
  submissionId: opt(text),
  assetParts: opt(map(int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }))),
}));

export type AppleReceipt = Parsed<typeof AppleReceiptSchema>;

