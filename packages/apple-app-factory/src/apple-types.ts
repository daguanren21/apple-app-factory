import { z } from 'zod';

const text = z.string().min(1);
const effect = z.strictObject({ id: text.optional() });

export const AppleReceiptSchema = z.strictObject({
  identity: z.strictObject({ appId: text, bundleId: text, version: text, buildNumber: text }).optional(),
  pending: z.strictObject({ key: text, path: text.optional(), method: z.enum(['POST', 'PATCH', 'PUT']).optional(), startedAt: z.iso.datetime().optional() }).nullable().optional(),
  effects: z.record(z.string(), effect).optional(),
  lastEffect: z.strictObject({ key: text, id: text.optional(), reconciled: z.boolean().optional(), completedAt: z.iso.datetime().optional() }).optional(),
  upload: z.strictObject({ status: z.enum(['intent', 'delivered', 'reconciled']), startedAt: z.iso.datetime().optional() }).optional(),
  phase: z.enum(['processing', 'submitted']).optional(),
  versionId: text.optional(),
  buildId: text.optional(),
  submissionId: text.optional(),
  assetParts: z.record(z.string(), z.number().int().nonnegative().safe()).optional(),
});

export interface AppleReceipt extends z.infer<typeof AppleReceiptSchema> {}

