import { arr, bool, int, lit, map, nullable, num, obj, oneOf, opt, str, union, unknown, type Static } from '@earendil-works/pi-schema';
import { isAbsolute, win32 } from 'node:path';
import { AppleReceiptSchema } from './apple-types.js';
import { validateMyGoPackaging } from './mygo-build.js';
import { MAX_INPUT_BYTES, minimumNodeResultBytes, minimumReviewBytes } from './input-limits.js';
import { NotificationConfigSchema, NotificationDeliverySchema } from './notification-types.js';
import { UiQualitySchema, minimumUiQualityBytes } from './ui-quality.js';
import { defineContract, emailSchema, isoDateTimeSchema, nonblankText, urlSchema, uuidSchema, type Parsed } from './validation.js';

const text = nonblankText();
const finiteNumber = num({ minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE });
const count = int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const positiveCount = int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const integer = int({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER });
const command = arr(text, { minItems: 1 });
const digest = str({ pattern: '^[a-f0-9]{64}$' });
const decisionLabel = str({ pattern: '^(?:$|(?=[\\s\\S]*\\S)(?![\\s\\S]*\\u0000)[\\s\\S]+)$' });
const decisionRationale = nonblankText(100000);
function relativeProjectPath(value: string, allowRoot = false): boolean {
  if (allowRoot && value === '.') return true;
  return !isAbsolute(value) && !win32.isAbsolute(value) && !/[\\:*?\[\]]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
const projectPath = defineContract({ ...nonblankText(), default: '.' }, { check: (value, issue) => {
  if (!relativeProjectPath(value, true)) issue([], 'project.directory must be a relative in-root directory without traversal');
} });
const artifactPath = defineContract(nonblankText(), { check: (value, issue) => {
  if (!relativeProjectPath(value)) issue([], 'artifactPath must be an exact project-relative file or directory without traversal or wildcards');
} });
export const FrameworkSchema = defineContract(oneOf(['flutter', 'android-java', 'swift', 'react-native', 'expo', 'uni-app', 'mygo']));
export type Framework = Parsed<typeof FrameworkSchema>;
export const PlatformSchema = defineContract(oneOf(['ios', 'android', 'macos']));
export type Platform = Parsed<typeof PlatformSchema>;
export const ChannelSchema = defineContract(oneOf(['local', 'app-store', 'google-play']));
export type Channel = Parsed<typeof ChannelSchema>;
export const PrioritySchema = defineContract(oneOf(['P0', 'P1', 'P2']));
export type Priority = Parsed<typeof PrioritySchema>;
export const PackageTargetSchema = defineContract(oneOf(['simulator', 'ipa', 'apk', 'aab', 'app', 'dmg']));
export type PackageTarget = Parsed<typeof PackageTargetSchema>;
export const AppleSpecSchema = defineContract(obj({
  appId: opt(text), bundleId: opt(text), buildNumber: opt(text), locale: opt(text),
  description: opt(text), keywords: opt(text), supportUrl: opt(text), privacyPolicyUrl: opt(text), reviewNotes: opt(text),
  copyright: opt(text), whatsNew: opt(text), storefrontCountry: opt(text), manualSetupConfirmed: opt(bool()),
  contact: opt(obj({ firstName: opt(text), lastName: opt(text), email: opt(text), phone: opt(text) })),
}));
export type AppleSpec = Parsed<typeof AppleSpecSchema>;
const specProperties = {
  id: str({ pattern: '^[a-z][a-z0-9-]{1,62}$' }), name: text, purpose: text, audience: text,
  framework: FrameworkSchema.schema, platform: PlatformSchema.schema,
  channel: { ...ChannelSchema.schema, default: 'local' }, version: nonblankTextWithDefault('1.0.0'),
  priority: { ...PrioritySchema.schema, default: 'P1' },
  project: opt(obj({ sourceDir: opt(text), directory: projectPath.schema })),
  screenshotsDir: opt(text), differentiators: arr(text, { minItems: 1 }), acceptance: arr(text, { minItems: 1 }),
  constraints: opt(arr(text)), designRef: opt(urlSchema({ nonblank: true, description: 'Actual design reference URL; preserve its authority and report unavailable source honestly' })),
  apple: opt(AppleSpecSchema.schema), authorEmail: opt(emailSchema()), hiddenFeatures: opt(lit(false)), reviewBypass: opt(lit(false)),
};
function nonblankTextWithDefault(value: string) { return { ...nonblankText(), default: value }; }
const specObject = obj(specProperties);
function refineSpec(value: Static<typeof specObject>, issue: (path: (string | number)[], message: string) => void): void {
  if (value.framework === 'android-java' && value.platform !== 'android') issue(['platform'], 'android-java requires platform=android');
  if (value.framework === 'swift' && value.platform !== 'ios') issue(['platform'], 'swift requires platform=ios');
  if (value.framework === 'mygo' && value.platform !== 'macos') issue(['platform'], 'mygo requires platform=macos');
  if (value.platform === 'macos' && value.framework !== 'mygo') issue(['framework'], 'macos currently requires framework=mygo');
  if (value.platform === 'macos' && value.channel !== 'local') issue(['channel'], 'macos currently supports local delivery only');
  if (value.channel === 'app-store' && value.platform !== 'ios') issue(['channel'], 'app-store requires platform=ios');
  if (value.channel === 'google-play' && value.platform !== 'android') issue(['channel'], 'google-play requires platform=android');
}
export const SpecSchema = defineContract(specObject, { check: refineSpec });
export type Spec = Parsed<typeof SpecSchema>;
export const RequirementSchema = defineContract(obj({ ...specProperties, baseJobId: opt(uuidSchema()) }), { check(value, issue) {
  refineSpec(value, issue);
  if (value.baseJobId && value.project?.sourceDir) issue(['project', 'sourceDir'], 'project.sourceDir and baseJobId are mutually exclusive');
} });
export const ObfuscationConfigSchema = defineContract(obj({
  command: { ...command, default: ['obfuscator'] }, configPath: opt(text), options: opt(map(unknown())), seed: opt(text),
}), { check(value, issue) {
  if (!value.configPath && !value.options) issue([], 'obfuscation needs configPath or inline options; set one of them');
  if (value.configPath && value.options) issue([], 'obfuscation accepts configPath or inline options, not both');
} });
export type ObfuscationConfig = Parsed<typeof ObfuscationConfigSchema>;
export const RoleSeatSchema = defineContract(union([text, obj({ name: text, provider: opt(text), fresh: bool({ default: false }) })]));
export type RoleSeat = Parsed<typeof RoleSeatSchema>;
export const RolesConfigSchema = defineContract(obj({
  research: opt(arr(RoleSeatSchema.schema)), build: opt(arr(RoleSeatSchema.schema)), review: opt(arr(RoleSeatSchema.schema)), receipt: bool({ default: false }),
}));
export type RolesConfig = Parsed<typeof RolesConfigSchema>;
export const WorkflowConfigSchema = defineContract(obj({
  maxNodes: int({ minimum: 1, maximum: 256, default: 64 }), maxParallel: int({ minimum: 1, maximum: 32, default: 4 }), maxReplans: int({ minimum: 0, maximum: 32, default: 4 }),
}));
export type WorkflowConfig = Parsed<typeof WorkflowConfigSchema>;
const executionVariable = defineContract(str({ pattern: '^[A-Z][A-Z0-9_]*$' }), { check(value, issue) {
  if (/^(ASC_|APPLE_|FASTLANE_|MATCH_)/.test(value)) issue([], 'Publisher credentials must not be passed to host or verification tools');
} });
export const ConfigSchema = defineContract(obj({
  configPath: opt(text), stateDir: text, workspaceRoot: text,
  projectMode: oneOf(['project', 'isolated'], { default: 'project' }), projectRoot: opt(text),
  allowLocalExecution: bool({ default: false }), allowCloudBuild: bool({ default: false }), autopilot: opt(bool()),
  executionEnv: arr(executionVariable.schema, { default: [] }),
  isolation: opt(obj({ mode: lit('macos-sandbox'), readOnlyPaths: arr(text, { default: [] }), network: oneOf(['deny', 'allow'], { default: 'deny' }) })),
  timeoutMs: num({ exclusiveMinimum: 0, default: 900000 }), maxAttempts: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 8 }),
  maxHostTurns: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 16 }), maxJobHours: num({ exclusiveMinimum: 0, default: 24 }),
  retryDelayMs: num({ exclusiveMinimum: 0, default: 30000 }), pollMs: num({ exclusiveMinimum: 0, default: 300000 }),
  inbox: opt(obj({ directory: text, pollMs: num({ exclusiveMinimum: 0, default: 2000 }) })),
  verification: obj({ prerequisites: arr(command, { default: [] }), checks: arr(command, { minItems: 1 }), runtime: arr(command, { minItems: 1 }) }),
  toolchain: opt(obj({ flutterSdk: text })), apple: opt(obj({ exportOptionsPlist: opt(text) })),
  packageTarget: PackageTargetSchema.schema, executionWarning: opt(text), obfuscation: opt(ObfuscationConfigSchema.schema),
  notifications: opt(NotificationConfigSchema.schema), roles: opt(RolesConfigSchema.schema), workflow: opt(WorkflowConfigSchema.schema), uiQuality: opt(bool()),
  packaging: opt(obj({ commands: arr(command, { minItems: 1 }), artifactPath: artifactPath.schema, provider: oneOf(['local', 'cloud'], { default: 'local' }) })),
}), { check(value, issue) {
  if (value.packaging?.provider === 'cloud' && !value.allowCloudBuild) issue(['allowCloudBuild'], 'Cloud packaging requires explicit allowCloudBuild=true');
  if (value.workflow) for (const stage of ['research', 'build', 'review'] as const) {
    const seats = value.roles?.[stage] ?? [];
    if (seats.length > value.workflow.maxNodes) issue(['roles', stage], `Required seats exceed workflow.maxNodes (${value.workflow.maxNodes})`);
    for (const [index, seat] of seats.entries()) {
      if ((typeof seat === 'string' ? seat : seat.name).length > 200 || typeof seat !== 'string' && (seat.provider?.length ?? 0) > 200) issue(['roles', stage, index], 'Dynamic role and provider names must fit the 200-character workflow node bound');
    }
  }
} });
export type Config = Parsed<typeof ConfigSchema>;
export function validateJobConfig(spec: Spec, config: Config): void {
  if (config.autopilot === true && !config.allowLocalExecution) throw new Error('autopilot requires allowLocalExecution=true: the owner must pre-authorize deterministic local execution before unattended mode');
  if (config.uiQuality && (!spec.screenshotsDir || !relativeProjectPath(spec.screenshotsDir) || !/^(build|dist|unpackage)\//.test(spec.screenshotsDir) || /(?:^|\/)(?:node_modules|\.git|\.factory-cache)(?:\/|$)/.test(spec.screenshotsDir))) throw new Error('UI quality requires screenshotsDir under generated app output, for example build/screenshots, and actual narrow/wide platform captures from the runtime checks');
  const reviewBytes = minimumReviewBytes(spec.acceptance) + (config.uiQuality ? minimumUiQualityBytes(spec.screenshotsDir!) : 0);
  const minimumResultBytes = config.workflow ? minimumNodeResultBytes(['x'], reviewBytes) : reviewBytes;
  if (minimumResultBytes > MAX_INPUT_BYTES) throw new Error(`Acceptance requires at least ${minimumResultBytes} completion bytes, exceeding the ${MAX_INPUT_BYTES}-byte input limit; split the requirement into independently deliverable products before enqueueing`);
  const targets: Record<Platform, readonly Config['packageTarget'][]> = { ios: ['simulator', 'ipa'], android: ['apk', 'aab'], macos: ['app', 'dmg'] };
  if (!targets[spec.platform].includes(config.packageTarget)) throw new Error(`packageTarget=${config.packageTarget} does not match platform=${spec.platform}`);
  if (spec.channel === 'google-play' && config.packageTarget !== 'aab') throw new Error('Google Play requires packageTarget=aab');
  if (config.toolchain && spec.framework !== 'flutter') throw new Error('toolchain.flutterSdk is only supported for framework=flutter');
  if (spec.framework !== 'flutter' && !config.packaging) throw new Error(`${spec.framework} requires owner-configured packaging.commands and packaging.artifactPath`);
  if (config.packaging?.provider === 'cloud' && !config.allowCloudBuild) throw new Error('Cloud packaging requires explicit allowCloudBuild=true');
  if (spec.platform === 'macos' && (config.allowCloudBuild || config.packaging?.provider === 'cloud')) throw new Error('macos currently supports local build-only delivery; notarization and uploads are not part of this tool');
  if (spec.framework === 'mygo') validateMyGoPackaging(config, spec.screenshotsDir);
}
export const StageSchema = defineContract(oneOf(['research', 'build', 'obfuscate', 'verify', 'review', 'package']));
export type Stage = Parsed<typeof StageSchema>;
export const StatusSchema = defineContract(oneOf(['queued', 'running', 'waiting', 'blocked', 'failed', 'needs-owner', 'ready', 'built']));
export type Status = Parsed<typeof StatusSchema>;
export const ToolchainSchema = defineContract(obj({ source: text, frameworkRevision: text, engineRevision: text, ready: bool() }));
export type Toolchain = Parsed<typeof ToolchainSchema>;
export const ProcessIdentitySchema = defineContract(obj({ token: text }));
export type ProcessIdentity = Parsed<typeof ProcessIdentitySchema>;
export const CommandMetadataSchema = defineContract(obj({ deadline: finiteNumber, identity: ProcessIdentitySchema.schema, termAt: opt(finiteNumber), killAt: opt(finiteNumber) }));
export type CommandMetadata = Parsed<typeof CommandMetadataSchema>;
export const PrerequisiteSchema = defineContract(obj({ argv: opt(arr(text)), reason: text, path: opt(text) }));
export type Prerequisite = Parsed<typeof PrerequisiteSchema>;
export const ResearchSchema = defineContract(obj({ viable: bool(), distinctness: text, risks: opt(arr(text)), plan: arr(text, { minItems: 1 }) }));
export type Research = Parsed<typeof ResearchSchema>;
export const ReviewSchema = defineContract(obj({ approved: bool(), findings: arr(text), acceptanceEvidence: arr(obj({ requirement: text, evidence: text })), uiQuality: opt(UiQualitySchema.schema) }));
export type Review = Parsed<typeof ReviewSchema>;
export const ArtifactSchema = defineContract(obj({ kind: oneOf(['ios-simulator', 'ipa', 'apk', 'aab', 'macos-app', 'dmg']), path: text, digest, createdAt: isoDateTimeSchema() }));
export type Artifact = Parsed<typeof ArtifactSchema>;
export const InboxEntrySchema = defineContract(obj({ source: text, digest: nullable(text), status: oneOf(['accepted', 'error']), jobId: nullable(text), error: nullable(str()), observedAt: finiteNumber }));
export type InboxEntry = Parsed<typeof InboxEntrySchema>;
export const HostStageSchema = defineContract(oneOf(['research', 'build', 'review']));
export type HostStage = Parsed<typeof HostStageSchema>;
export const HostTurnSchema = defineContract(obj({
  id: uuidSchema(), stage: HostStageSchema.schema, createdAt: finiteNumber, contextDigest: digest,
  decisionsLengthAtClaim: opt(count), ownerPid: opt(positiveCount), ownerIdentity: opt(text),
  kind: opt(oneOf(['plan', 'node'])), nodeId: opt(text), planRevision: opt(count),
}));
export type HostTurn = Parsed<typeof HostTurnSchema>;
const workflowNodeId = str({ pattern: '^[a-z][a-z0-9_-]{0,63}$' });
const workflowPath = defineContract(nonblankText(), { check(value, issue) {
  if (!relativeProjectPath(value, true)) issue([], 'Expected a project-relative file or directory, or .');
} });
export const WorkflowNodeSchema = defineContract(obj({
  id: workflowNodeId, role: nonblankText(200), instructions: nonblankText(20000),
  dependsOn: arr(workflowNodeId, { maxItems: 256, default: [] }), readPaths: arr(workflowPath.schema, { maxItems: 256, default: ['.'] }),
  writePaths: arr(workflowPath.schema, { maxItems: 256, default: [] }), acceptance: arr(nonblankText(2000), { minItems: 1, maxItems: 64 }),
  provider: opt(nonblankText(200)), fresh: bool({ default: false }),
}));
export type WorkflowNode = Parsed<typeof WorkflowNodeSchema>;
export const WorkflowPlanSchema = defineContract(obj({ rationale: nonblankText(20000), nodes: arr(WorkflowNodeSchema.schema, { minItems: 1, maxItems: 256 }), final: workflowNodeId, invalidate: arr(workflowNodeId, { maxItems: 256, default: [] }) }));
export type WorkflowPlan = Parsed<typeof WorkflowPlanSchema>;
export const WorkflowNodeResultSchema = defineContract(obj({ outcome: oneOf(['passed', 'failed']), summary: nonblankText(20000), evidence: arr(obj({ requirement: nonblankText(2000), evidence: nonblankText(20000) }), { maxItems: 64 }), result: opt(unknown()) }));
export type WorkflowNodeResult = Parsed<typeof WorkflowNodeResultSchema>;
export const WorkflowNodeStateSchema = defineContract(obj({
  definition: WorkflowNodeSchema.schema, status: oneOf(['pending', 'running', 'passed', 'failed']), attempts: { ...count, default: 0 }, turn: { ...nullable(HostTurnSchema.schema), default: null },
  result: opt(WorkflowNodeResultSchema.schema), completedAt: opt(finiteNumber), decisionsLengthAtClaim: opt(count),
}));
export type WorkflowNodeState = Parsed<typeof WorkflowNodeStateSchema>;
export const WorkflowPhaseSchema = defineContract(obj({
  status: oneOf(['planning', 'running', 'complete']), revision: { ...count, default: 0 }, reason: text, final: opt(workflowNodeId),
  nodes: arr(WorkflowNodeStateSchema.schema, { maxItems: 256, default: [] }),
  history: arr(obj({ revision: positiveCount, at: finiteNumber, reason: text, plan: WorkflowPlanSchema.schema }), { default: [] }),
  decisionsLengthAtClaim: opt(count), proofDigest: opt(nullable(digest)),
}));
export type WorkflowPhase = Parsed<typeof WorkflowPhaseSchema>;
export const WorkflowStateSchema = defineContract(obj({ cancelled: bool({ default: false }), phases: obj({ research: opt(WorkflowPhaseSchema.schema), build: opt(WorkflowPhaseSchema.schema), review: opt(WorkflowPhaseSchema.schema) }) }));
export type WorkflowState = Parsed<typeof WorkflowStateSchema>;
const absoluteSource = defineContract(nonblankText(), { check(value, issue) { if (!isAbsolute(value)) issue([], 'sourceDirectory must be absolute'); } });
export const JobSchema = defineContract(obj({
  id: text, spec: SpecSchema.schema, requestSpec: nullable(SpecSchema.schema), requestSpecError: nullable(text, { default: null }), config: ConfigSchema.schema,
  stage: StageSchema.schema, status: StatusSchema.schema, createdAt: finiteNumber, updatedAt: finiteNumber, nextAt: finiteNumber,
  attempts: { ...map(count), propertyNames: StageSchema.schema }, hostTurns: count, turn: opt(nullable(HostTurnSchema.schema)), groups: arr(integer), workflow: opt(WorkflowStateSchema.schema),
  decisions: arr(obj({ at: finiteNumber, stage: decisionLabel, role: decisionLabel, rationale: decisionRationale }), { default: [] }),
  commands: map(CommandMetadataSchema.schema, { default: {} }), receipt: AppleReceiptSchema.schema, logs: arr(text), workspace: text, projectRoot: text,
  projectDigest: opt(nullable(digest)), projectDependencyDigest: opt(nullable(digest)), baseJobId: opt(uuidSchema()), baseDigest: opt(digest), basePrepared: opt(bool()), automaticBase: opt(lit(true)),
  sourceDirectory: opt(absoluteSource.schema), importDigest: opt(digest), importPrepared: opt(bool()), cloudBuildPending: opt(bool()), recoveryStage: opt(StageSchema.schema),
  blockedReason: opt(nullable(obj({ kind: lit('prerequisite'), stage: StageSchema.schema, prerequisite: PrerequisiteSchema.schema }))),
  manualRecovery: opt(nullable(str())), error: opt(nullable(str())), feedback: opt(str()), research: opt(ResearchSchema.schema),
  policyEvidence: opt(obj({ url: urlSchema(), fetchedAt: text, sha256: text })), toolchain: opt(ToolchainSchema.schema),
  verifiedDigest: opt(nullable(text)), verifiedDependencyDigest: opt(nullable(digest)), screenshotDigest: opt(nullable(text)), verifiedAt: opt(text),
  obfuscationBase: opt(obj({ digest, path: text })), obfuscationDigest: opt(digest),
  obfuscationReport: opt(obj({ changedFiles: count, transforms: { ...map(count), propertyNames: text }, skipped: obj({ generated: count, unsupported: count }) })),
  review: opt(nullable(ReviewSchema.schema)), ipaPath: opt(nullable(text)), archiveDigest: opt(nullable(text)), artifact: opt(nullable(ArtifactSchema.schema)),
  notifications: arr(NotificationDeliverySchema.schema, { default: [] }), externalChecks: opt(unknown()),
}, { open: true }));
export type Job = Parsed<typeof JobSchema> & Record<string, unknown>;
export const DecisionEntrySchema = defineContract(obj({ at: finiteNumber, stage: decisionLabel, role: decisionLabel, rationale: decisionRationale }));
export type DecisionEntry = Parsed<typeof DecisionEntrySchema>;
export const DecisionInputSchema = defineContract(obj({ stage: { ...decisionLabel, default: '' }, role: { ...decisionLabel, default: '' }, rationale: decisionRationale }));
export type DecisionInput = Parsed<typeof DecisionInputSchema>;
export type FactoryError = Error & { code?: string; syscall?: string; prerequisite?: Prerequisite; httpStatus?: number | null; outcome?: string; transient?: boolean };
export function toError(value: unknown): FactoryError { return value instanceof Error ? value : new Error(String(value)); }
