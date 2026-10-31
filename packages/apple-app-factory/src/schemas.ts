import { z } from 'zod';
import { dirname, isAbsolute, resolve, win32 } from 'node:path';
import { lstatSync } from 'node:fs';
import { AppleReceiptSchema } from './apple-types.js';
import { validateMyGoPackaging } from './mygo-build.js';

const text = z.string().min(1).refine(value => value.trim().length > 0 && !value.includes('\0'), 'Expected non-empty text without NUL characters');
const count = z.number().int().nonnegative().safe();
const positive = z.number().positive().finite();
const command = z.array(text).min(1);
/** Decision-log stage/role labels may be empty because apphx decide defaults omitted fields to ''. */
const decisionLabel = z.string().refine(value => !value.includes('\0') && (value === '' || value.trim().length > 0), 'Expected text without NUL characters');
/** Decision rationale is a non-empty, longer text so every recorded verdict stays attributable. */
const decisionRationale = z.string().min(1).max(100000).refine(value => value.trim().length > 0 && !value.includes('\0'), 'Expected non-empty text without NUL characters');

function relativeProjectPath(value: string, allowRoot = false): boolean {
  if (allowRoot && value === '.') return true;
  return !isAbsolute(value) && !win32.isAbsolute(value) && !/[\\:*?\[\]]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export const FrameworkSchema = z.enum(['flutter', 'android-java', 'swift', 'react-native', 'expo', 'uni-app', 'mygo']);
export type Framework = z.infer<typeof FrameworkSchema>;
export const PlatformSchema = z.enum(['ios', 'android', 'macos']);
export type Platform = z.infer<typeof PlatformSchema>;
export const ChannelSchema = z.enum(['local', 'app-store', 'google-play']);
export type Channel = z.infer<typeof ChannelSchema>;
export const PrioritySchema = z.enum(['P0', 'P1', 'P2']);
export type Priority = z.infer<typeof PrioritySchema>;
export const PackageTargetSchema = z.enum(['simulator', 'ipa', 'apk', 'aab', 'app', 'dmg']);
export type PackageTarget = z.infer<typeof PackageTargetSchema>;
export const AppleSpecSchema = z.strictObject({
  appId: text.optional(), bundleId: text.optional(), buildNumber: text.optional(), locale: text.optional(),
  description: text.optional(), keywords: text.optional(), supportUrl: text.optional(), privacyPolicyUrl: text.optional(), reviewNotes: text.optional(),
  copyright: text.optional(), whatsNew: text.optional(), storefrontCountry: text.optional(), manualSetupConfirmed: z.boolean().optional(),
  contact: z.strictObject({ firstName: text.optional(), lastName: text.optional(), email: text.optional(), phone: text.optional() }).optional(),
});
export type AppleSpec = z.infer<typeof AppleSpecSchema>;
const SpecObject = z.strictObject({
  id: text.regex(/^[a-z][a-z0-9-]{1,62}$/), name: text, purpose: text, audience: text,
  framework: FrameworkSchema, platform: PlatformSchema, channel: ChannelSchema.default('local'), version: text.default('1.0.0'),
  priority: PrioritySchema.default('P1'),
  project: z.strictObject({ sourceDir: text.optional(), directory: text.refine(value => relativeProjectPath(value, true), 'project.directory must be a relative in-root directory without traversal').default('.') }).optional(),
  screenshotsDir: text.optional(), differentiators: z.array(text).min(1), acceptance: z.array(text).min(1),
  constraints: z.array(text).optional(),
  designRef: text.url().describe('Design reference URL (e.g. Figma link); the build\'s ui-designer role must reproduce the referenced design faithfully').optional(),
  apple: AppleSpecSchema.optional(),
  authorEmail: z.string().email().optional(),
  hiddenFeatures: z.literal(false).optional(), reviewBypass: z.literal(false).optional(),
});
function refineSpec(value: z.infer<typeof SpecObject>, context: z.RefinementCtx): void {
  if (value.framework === 'android-java' && value.platform !== 'android') context.addIssue({ code: 'custom', path: ['platform'], message: 'android-java requires platform=android' });
  if (value.framework === 'swift' && value.platform !== 'ios') context.addIssue({ code: 'custom', path: ['platform'], message: 'swift requires platform=ios' });
  if (value.framework === 'mygo' && value.platform !== 'macos') context.addIssue({ code: 'custom', path: ['platform'], message: 'mygo requires platform=macos' });
  if (value.platform === 'macos' && value.framework !== 'mygo') context.addIssue({ code: 'custom', path: ['framework'], message: 'macos currently requires framework=mygo' });
  if (value.platform === 'macos' && value.channel !== 'local') context.addIssue({ code: 'custom', path: ['channel'], message: 'macos currently supports local delivery only' });
  if (value.channel === 'app-store' && value.platform !== 'ios') context.addIssue({ code: 'custom', path: ['channel'], message: 'app-store requires platform=ios' });
  if (value.channel === 'google-play' && value.platform !== 'android') context.addIssue({ code: 'custom', path: ['channel'], message: 'google-play requires platform=android' });
}
export const SpecSchema = SpecObject.superRefine(refineSpec);
export type Spec = z.infer<typeof SpecSchema>;
export const RequirementSchema = SpecObject.extend({ baseJobId: z.uuid().optional() }).superRefine((value, context) => {
  refineSpec(value, context);
  if (value.baseJobId && value.project?.sourceDir) context.addIssue({ code: 'custom', path: ['project', 'sourceDir'], message: 'project.sourceDir and baseJobId are mutually exclusive' });
});

export const ObfuscationConfigSchema = z.strictObject({
  command: z.array(command.element).min(1).default(['obfuscator']),
  /** Obfuscator rules file resolved against the factory config directory; must be a regular file. */
  configPath: text.optional(),
  /** Inline obfuscator rules (same shape as the rules file); validated by the bundled obfuscator at run time. */
  options: z.record(z.string(), z.unknown()).optional(),
  seed: text.optional(),
}).superRefine((value, context) => {
  if (!value.configPath && !value.options) context.addIssue({ code: 'custom', path: [], message: 'obfuscation needs configPath or inline options; set one of them' });
  if (value.configPath && value.options) context.addIssue({ code: 'custom', path: [], message: 'obfuscation accepts configPath or inline options, not both' });
});
export type ObfuscationConfig = z.infer<typeof ObfuscationConfigSchema>;

/**
 * One advisory role seat. Accepts the legacy plain-name form or a pinned seat
 * object ({ name, provider?, fresh? }); provider pins the seat to a model
 * family and fresh=true requires a brand-new context.
 */
export const RoleSeatSchema = z.union([
  text,
  z.strictObject({ name: text, provider: text.optional(), fresh: z.boolean().default(false) }),
]);
export type RoleSeat = z.infer<typeof RoleSeatSchema>;

/**
 * Advisory role assignments per host stage. Role names are free-form so teams
 * can add any missing agent (e.g. security-review, performance-analyst); the
 * host adopts every returned role via its native delegation. Roles never
 * change stage eligibility, budgets or evidence gates. Each stage defaults so
 * factories may override a single stage without re-declaring the others.
 */
export const RolesConfigSchema = z.strictObject({
  research: z.array(RoleSeatSchema).default(['product-analyst']),
  build: z.array(RoleSeatSchema).default(['ui-designer', 'developer']),
  review: z.array(RoleSeatSchema).default(['architect-review', 'qa-engineer', 'acceptance-reviewer']),
});
export type RolesConfig = z.infer<typeof RolesConfigSchema>;

export const NotifyEmailSchema = z.strictObject({
  from: z.string().email(),
  to: z.string().email(),
  smtpHost: text,
  smtpPort: z.number().int().positive().default(465),
  secure: z.boolean().default(true),
  user: text.optional(),
  /** Environment variable name holding the SMTP password; the value is never stored or printed. */
  passwordEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  timeoutMs: z.number().int().positive().default(15000),
  subject: text.optional(),
  body: text.optional(),
});
export type NotifyEmail = z.infer<typeof NotifyEmailSchema>;

export const ConfigSchema = z.strictObject({
  configPath: text.optional(), stateDir: text, workspaceRoot: text,
  allowLocalExecution: z.boolean().default(false), allowCloudBuild: z.boolean().default(false),
  autopilot: z.boolean().optional(),
  executionEnv: z.array(text.regex(/^[A-Z][A-Z0-9_]*$/).refine(value => !/^(ASC_|APPLE_|FASTLANE_|MATCH_)/.test(value), 'Publisher credentials must not be passed to host or verification tools')).default([]),
  isolation: z.strictObject({ mode: z.literal('macos-sandbox'), readOnlyPaths: z.array(text).default([]), network: z.enum(['deny', 'allow']).default('deny') }).optional(),
  timeoutMs: positive.default(900000), maxAttempts: positive.int().default(8), maxHostTurns: positive.int().default(16), maxJobHours: positive.default(24),
  retryDelayMs: positive.default(30000), pollMs: positive.default(300000),
  inbox: z.strictObject({ directory: text, pollMs: positive.default(2000) }).optional(),
  verification: z.strictObject({ prerequisites: z.array(command).default([]), checks: z.array(command).min(1), runtime: z.array(command).min(1) }),
  toolchain: z.strictObject({ flutterSdk: text }).optional(),
  apple: z.strictObject({ exportOptionsPlist: text.optional() }).optional(),
  packageTarget: PackageTargetSchema, executionWarning: text.optional(),
  obfuscation: ObfuscationConfigSchema.optional(),
  notify: z.strictObject({ email: NotifyEmailSchema }).optional(),
  roles: RolesConfigSchema.optional(),
  packaging: z.strictObject({ commands: z.array(command).min(1), artifactPath: text.refine(value => relativeProjectPath(value), 'artifactPath must be an exact project-relative file or directory without traversal or wildcards'), provider: z.enum(['local', 'cloud']).default('local') }).optional(),
}).superRefine((value, context) => {
  if (value.packaging?.provider === 'cloud' && !value.allowCloudBuild) context.addIssue({ code: 'custom', path: ['allowCloudBuild'], message: 'Cloud packaging requires explicit allowCloudBuild=true' });
});
export type Config = z.infer<typeof ConfigSchema>;
export function validateJobConfig(spec: Spec, config: Config): void {
  if (config.autopilot === true && !config.allowLocalExecution) throw new Error('autopilot requires allowLocalExecution=true: the owner must pre-authorize deterministic local execution before unattended mode');
  const targets: Record<Platform, readonly Config['packageTarget'][]> = { ios: ['simulator', 'ipa'], android: ['apk', 'aab'], macos: ['app', 'dmg'] };
  if (!targets[spec.platform].includes(config.packageTarget)) throw new Error(`packageTarget=${config.packageTarget} does not match platform=${spec.platform}`);
  if (spec.channel === 'google-play' && config.packageTarget !== 'aab') throw new Error('Google Play requires packageTarget=aab');
  if (config.toolchain && spec.framework !== 'flutter') throw new Error('toolchain.flutterSdk is only supported for framework=flutter');
  if (spec.framework !== 'flutter' && !config.packaging) throw new Error(`${spec.framework} requires owner-configured packaging.commands and packaging.artifactPath`);
  if (config.packaging?.provider === 'cloud' && !config.allowCloudBuild) throw new Error('Cloud packaging requires explicit allowCloudBuild=true');
  if (spec.platform === 'macos' && (config.allowCloudBuild || config.packaging?.provider === 'cloud')) throw new Error('macos currently supports local build-only delivery; notarization and uploads are not part of this tool');
  if (spec.framework === 'mygo') validateMyGoPackaging(config, spec.screenshotsDir);
}
export const StageSchema = z.enum(['research', 'build', 'obfuscate', 'verify', 'review', 'package']);
export type Stage = z.infer<typeof StageSchema>;
export const StatusSchema = z.enum(['queued', 'running', 'waiting', 'blocked', 'failed', 'needs-owner', 'ready', 'built']);
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
  viable: z.boolean(), distinctness: text, risks: z.array(text).optional(), plan: z.array(text).min(1),
});
export type Research = z.infer<typeof ResearchSchema>;
export const ReviewSchema = z.strictObject({ approved: z.boolean(), findings: z.array(text), acceptanceEvidence: z.array(z.strictObject({ requirement: text, evidence: text })) });
export type Review = z.infer<typeof ReviewSchema>;
export const ArtifactSchema = z.strictObject({ kind: z.enum(['ios-simulator', 'ipa', 'apk', 'aab', 'macos-app', 'dmg']), path: text, digest: text.regex(/^[a-f0-9]{64}$/), createdAt: z.iso.datetime() });
export type Artifact = z.infer<typeof ArtifactSchema>;
export const InboxEntrySchema = z.strictObject({
  source: text, digest: text.nullable(), status: z.enum(['accepted', 'error']), jobId: text.nullable(),
  error: z.string().nullable(), observedAt: z.number().finite(),
});
export type InboxEntry = z.infer<typeof InboxEntrySchema>;
export const HostStageSchema = z.enum(['research', 'build', 'review']);
export type HostStage = z.infer<typeof HostStageSchema>;
export const HostTurnSchema = z.strictObject({
  id: z.uuid(), stage: HostStageSchema, createdAt: z.number().finite(), contextDigest: text.regex(/^[a-f0-9]{64}$/),
});
export type HostTurn = z.infer<typeof HostTurnSchema>;
export const JobSchema = z.object({
  id: text, spec: SpecSchema, requestSpec: SpecSchema.nullable(), requestSpecError: text.nullable().default(null), config: ConfigSchema, stage: StageSchema, status: StatusSchema,
  createdAt: z.number().finite(), updatedAt: z.number().finite(), nextAt: z.number().finite(),
  attempts: z.partialRecord(StageSchema, count), hostTurns: count, turn: HostTurnSchema.nullable().optional(), groups: z.array(z.number().int()),
  decisions: z.array(z.strictObject({ at: z.number().finite(), stage: decisionLabel, role: decisionLabel, rationale: decisionRationale })).default([]),
  commands: z.record(z.string(), CommandMetadataSchema).default({}), receipt: AppleReceiptSchema, logs: z.array(text), workspace: text,
  baseJobId: z.uuid().optional(), baseDigest: text.regex(/^[a-f0-9]{64}$/).optional(), basePrepared: z.boolean().optional(),
  automaticBase: z.literal(true).optional(),
  sourceDirectory: text.refine(isAbsolute, 'sourceDirectory must be absolute').optional(), importDigest: text.regex(/^[a-f0-9]{64}$/).optional(), importPrepared: z.boolean().optional(), cloudBuildPending: z.boolean().optional(),
  recoveryStage: StageSchema.optional(),
  blockedReason: z.strictObject({ kind: z.literal('prerequisite'), stage: StageSchema, prerequisite: PrerequisiteSchema }).nullable().optional(),
  manualRecovery: z.string().nullable().optional(), error: z.string().nullable().optional(), feedback: z.string().optional(),
  research: ResearchSchema.optional(), policyEvidence: z.strictObject({ url: z.url(), fetchedAt: text, sha256: text }).optional(),
  toolchain: ToolchainSchema.optional(), verifiedDigest: text.nullable().optional(), verifiedDependencyDigest: text.regex(/^[a-f0-9]{64}$/).nullable().optional(), screenshotDigest: text.nullable().optional(), verifiedAt: text.optional(),
  obfuscationBase: z.strictObject({ digest: text.regex(/^[a-f0-9]{64}$/), path: text }).optional(),
  obfuscationDigest: text.regex(/^[a-f0-9]{64}$/).optional(),
  obfuscationReport: z.strictObject({ changedFiles: count, transforms: z.record(text, count), skipped: z.strictObject({ generated: count, unsupported: count }) }).optional(),
  review: ReviewSchema.nullable().optional(), ipaPath: text.nullable().optional(), archiveDigest: text.nullable().optional(), artifact: ArtifactSchema.nullable().optional(),
  notifiedAt: text.nullable().optional(), notifiedTo: text.nullable().optional(), notifyError: text.nullable().optional(), notifySendingAt: text.nullable().optional(),
  externalChecks: z.unknown().optional(),
}).passthrough();
export type Job = z.infer<typeof JobSchema>;

export const DecisionEntrySchema = z.strictObject({ at: z.number().finite(), stage: decisionLabel, role: decisionLabel, rationale: decisionRationale });
export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;
export const DecisionInputSchema = z.strictObject({ stage: decisionLabel.default(''), role: decisionLabel.default(''), rationale: decisionRationale });
export type DecisionInput = z.infer<typeof DecisionInputSchema>;

export type FactoryError = Error & { code?: string; syscall?: string; prerequisite?: Prerequisite; httpStatus?: number | null; outcome?: string; transient?: boolean };
export function toError(value: unknown): FactoryError {
  return value instanceof Error ? value : new Error(String(value));
}
