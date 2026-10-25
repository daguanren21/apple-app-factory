import { z } from 'zod';
import { AppleReceiptSchema } from './apple-types.js';

const text = z.string().min(1).refine(value => value.trim().length > 0 && !value.includes('\0'), 'Expected non-empty text without NUL characters');
const count = z.number().int().nonnegative().safe();
const positive = z.number().positive().finite();
const command = z.array(text).min(1);

export const ProviderSchema = z.strictObject({
  kind: z.enum(['codex', 'cursor', 'pi', 'deepseek']),
  executable: text.optional(),
  model: text.refine(value => !value.startsWith('-'), 'Model must not start with an option prefix').optional(),
  provider: text.refine(value => !value.startsWith('-'), 'Provider must not start with an option prefix').optional(),
}).superRefine((value, context) => {
  if (value.kind === 'cursor' && value.provider !== undefined) context.addIssue({ code: 'custom', message: 'Cursor routes providers through model, not provider' });
  if (value.kind === 'pi' && value.provider !== undefined && value.model === undefined) context.addIssue({ code: 'custom', message: 'Pi provider selection requires model' });
  if (value.kind === 'deepseek' && (value.model !== undefined || value.provider !== undefined)) context.addIssue({ code: 'custom', message: 'Configure model routing in the DeepSeek headless profile' });
});
export type Provider = z.infer<typeof ProviderSchema>;

export const AppleSpecSchema = z.strictObject({
  appId: text.optional(), bundleId: text.optional(), version: text.optional(), buildNumber: text.optional(), locale: text.optional(),
  description: text.optional(), keywords: text.optional(), supportUrl: text.optional(), privacyPolicyUrl: text.optional(), reviewNotes: text.optional(),
  copyright: text.optional(), whatsNew: text.optional(), storefrontCountry: text.optional(), screenshotsDir: text.optional(), manualSetupConfirmed: z.boolean().optional(),
  contact: z.strictObject({ firstName: text.optional(), lastName: text.optional(), email: text.optional(), phone: text.optional() }).optional(),
});
export type AppleSpec = z.infer<typeof AppleSpecSchema>;
export const SpecSchema = z.strictObject({
  id: text.regex(/^[a-z][a-z0-9-]{1,62}$/), name: text, purpose: text, audience: text,
  framework: z.literal('flutter'), differentiators: z.array(text).min(1), acceptance: z.array(text).min(1),
  constraints: z.array(text).optional(), apple: AppleSpecSchema.optional(),
  hiddenFeatures: z.literal(false).optional(), reviewBypass: z.literal(false).optional(),
});
export type Spec = z.infer<typeof SpecSchema>;
export const RequirementSchema = SpecSchema.extend({ baseJobId: z.uuid().optional() });

export const ConfigSchema = z.strictObject({
  configPath: text.optional(), stateDir: text, workspaceRoot: text,
  allowLocalExecution: z.boolean().default(false), allowSubmit: z.boolean().default(false), allowRelease: z.boolean().default(false),
  builder: ProviderSchema, reviewer: ProviderSchema, researcher: ProviderSchema.optional(),
  agentEnv: z.array(text.regex(/^[A-Z][A-Z0-9_]*$/).refine(value => !/^(ASC_|APPLE_|FASTLANE_|MATCH_)/.test(value), 'Publisher credentials must not be passed to agents')).default([]),
  timeoutMs: positive.default(900000), maxAttempts: positive.int().default(3), maxAgentCalls: positive.int().default(16), maxJobHours: positive.default(24),
  retryDelayMs: positive.default(30000), pollMs: positive.default(300000),
  maxConcurrentJobs: positive.int().max(16).default(2),
  inbox: z.strictObject({ directory: text, pollMs: positive.default(2000) }).optional(),
  verification: z.strictObject({ prerequisites: z.array(command).default([]), checks: z.array(command).min(1), runtime: z.array(command).min(1) }),
  toolchain: z.strictObject({ flutterSdk: text }).optional(),
  apple: z.strictObject({ exportOptionsPlist: text.optional() }).optional(),
  packageTarget: z.enum(['simulator', 'ipa']).optional(), executionWarning: text.optional(),
}).transform(value => ({ ...value, packageTarget: value.packageTarget ?? (value.allowSubmit ? 'ipa' as const : 'simulator' as const) })).superRefine((value, context) => {
  if (value.allowSubmit && value.packageTarget !== 'ipa') context.addIssue({ code: 'custom', path: ['packageTarget'], message: 'Submission requires packageTarget=ipa; simulator builds cannot be uploaded' });
  if (value.allowRelease && !value.allowSubmit) context.addIssue({ code: 'custom', path: ['allowRelease'], message: 'allowRelease requires allowSubmit' });
});
export type Config = z.infer<typeof ConfigSchema>;
export const StageSchema = z.enum(['research', 'build', 'verify', 'review', 'package', 'publish', 'monitor']);
export type Stage = z.infer<typeof StageSchema>;
export const StatusSchema = z.enum(['queued', 'running', 'waiting', 'blocked', 'failed', 'ready', 'built', 'approved', 'released']);
export type Status = z.infer<typeof StatusSchema>;
export const ToolchainSchema = z.strictObject({ source: text, frameworkRevision: text, engineRevision: text, ready: z.boolean() });
export type Toolchain = z.infer<typeof ToolchainSchema>;
export const ProcessIdentitySchema = z.strictObject({ token: text });
export type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>;
export const CommandMetadataSchema = z.strictObject({ deadline: z.number().finite(), identity: ProcessIdentitySchema, termAt: z.number().finite().optional(), killAt: z.number().finite().optional() });
export type CommandMetadata = z.infer<typeof CommandMetadataSchema>;
export const PrerequisiteSchema = z.strictObject({ argv: z.array(text).optional(), reason: text, path: text.optional() });
export type Prerequisite = z.infer<typeof PrerequisiteSchema>;
export const ResearchSchema = z.strictObject({
  viable: z.boolean(), policySources: z.array(z.strictObject({ rule: text, url: z.url() })), distinctness: text, risks: z.array(text).optional(), plan: z.array(text).min(1),
});
export type Research = z.infer<typeof ResearchSchema>;
export const ReviewSchema = z.strictObject({ approved: z.boolean(), findings: z.array(text), acceptanceEvidence: z.array(z.strictObject({ requirement: text, evidence: text })) });
export type Review = z.infer<typeof ReviewSchema>;
export const ArtifactSchema = z.strictObject({ kind: z.enum(['ios-simulator', 'ipa']), path: text, digest: text.regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime() });
export type Artifact = z.infer<typeof ArtifactSchema>;
export const ApplePollResultSchema = z.strictObject({ status: z.enum(['waiting', 'approved', 'rejected']), detail: text, distributionReady: z.boolean().optional(), available: z.boolean().optional() });
export const InboxEntrySchema = z.strictObject({
  source: text, digest: text.nullable(), status: z.enum(['accepted', 'error']), jobId: text.nullable(),
  error: z.string().nullable(), observedAt: z.number().finite(),
});
export type InboxEntry = z.infer<typeof InboxEntrySchema>;
export const JobSchema = z.object({
  id: text, spec: SpecSchema, requestSpec: SpecSchema.nullable(), requestSpecError: text.nullable().default(null), config: ConfigSchema, stage: StageSchema, status: StatusSchema,
  createdAt: z.number().finite(), updatedAt: z.number().finite(), nextAt: z.number().finite(),
  attempts: z.partialRecord(StageSchema, count), agentCalls: count, groups: z.array(z.number().int()),
  commands: z.record(z.string(), CommandMetadataSchema).default({}), receipt: AppleReceiptSchema, logs: z.array(text), workspace: text,
  baseJobId: z.uuid().optional(), baseDigest: text.regex(/^[a-f0-9]{64}$/).optional(), basePrepared: z.boolean().optional(),
  recoveryStage: StageSchema.optional(),
  blockedReason: z.strictObject({ kind: z.literal('prerequisite'), stage: StageSchema, prerequisite: PrerequisiteSchema }).nullable().optional(),
  manualRecovery: z.string().nullable().optional(), error: z.string().nullable().optional(), feedback: z.string().optional(),
  research: ResearchSchema.optional(), policyEvidence: z.strictObject({ url: z.url(), fetchedAt: text, sha256: text }).optional(),
  toolchain: ToolchainSchema.optional(), verifiedDigest: text.nullable().optional(), verifiedDependencyDigest: text.regex(/^[a-f0-9]{64}$/).nullable().optional(), screenshotDigest: text.nullable().optional(), verifiedAt: text.optional(),
  review: ReviewSchema.nullable().optional(), ipaPath: text.nullable().optional(), archiveDigest: text.nullable().optional(), artifact: ArtifactSchema.nullable().optional(),
  appleReview: ApplePollResultSchema.optional(), externalChecks: z.unknown().optional(),
}).passthrough();
export type Job = z.infer<typeof JobSchema>;

export type FactoryError = Error & { code?: string; syscall?: string; prerequisite?: Prerequisite; httpStatus?: number | null; outcome?: string; transient?: boolean };
export function toError(value: unknown): FactoryError {
  return value instanceof Error ? value : new Error(String(value));
}
