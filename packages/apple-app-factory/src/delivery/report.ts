import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalPath, inside } from '../configuration/config.js';
import { generatedModulePaths, isGeneratedPath } from '../projects/dependencies.js';
import { deliveryManifest, type DeliveryManifest } from './manifest.js';
import { toError, type Config, type Job } from '../contracts/schemas.js';
import type { Store } from '../state/store.js';
import { assertPinnedProjectRoots, sourceDigest, sourceProjectDirectory } from '../projects/workspace.js';

export type ChecklistStatus = 'passed' | 'failed' | 'uncovered' | 'unreviewed';
export type FailureKind = 'review-finding' | 'job-error' | 'blocked' | 'acceptance';

export interface ChecklistEntry {
  requirement: string;
  status: ChecklistStatus;
  evidence: string | null;
  reason: string | null;
}

export interface FailureEntry {
  item: FailureKind;
  requirement?: string;
  detail: string;
}

export interface ReportVerified {
  sourceDigest: string | null;
  dependencyDigest: string | null;
  screenshotDigest: string | null;
  verifiedAt?: string;
  obfuscationDigest?: string;
  obfuscationReport?: Job['obfuscationReport'];
}

export interface ReportSource {
  projectRoot: string;
  sourcePath: string;
  executionPath: string;
  recordedDigest: string | null;
  currentDigest: string | null;
  verification: 'matches-verification' | 'matches-execution-snapshot' | 'unverified';
  reason: string;
}

export interface Report {
  job: {
    id: string;
    product: string;
    version: string;
    framework: string;
    platform: string;
    channel: string;
    status: string;
    stage: string;
    createdAt: number;
    updatedAt: number;
    attempts: Job['attempts'];
    hostTurns: number;
  };
  decisions: Job['decisions'];
  workflow?: Job['workflow'];
  error?: string | null;
  feedback?: string;
  blockedReason?: NonNullable<Job['blockedReason']>;
  manualRecovery?: string | null;
  verified: ReportVerified;
  artifact: Job['artifact'] | null;
  checklist: ChecklistEntry[];
  failures: FailureEntry[];
  source: ReportSource;
  delivery: DeliveryManifest;
  uiQuality?: NonNullable<Job['review']>['uiQuality'];
}

export interface ReportOptions {
  out?: string;
  collect?: boolean;
  buildOnly?: boolean;
  config?: Config;
}

export interface ReportSummary {
  report: string;
  markdown: string;
  delivery: DeliveryManifest;
  checklist: Record<ChecklistStatus, number>;
  failures: number;
  collect?: { source: string; artifact: string | null; role: 'secondary-source-snapshot'; sourceDigest: string | null };
}

function assertBuildOnly(config: Config | undefined): void {
  if (!config) return;
  // Publication permissions were removed from the configuration contract and
  // loadConfig already rejects them; this mirrors that assertion for any
  // build-only report so a store-publishing config can never be treated as a
  // local build handoff.
  const forbidden = ['allowSubmit', 'allowRelease'].filter(key => key in (config as unknown as Record<string, unknown>));
  if (forbidden.length) {
    throw Object.assign(new Error(`--build-only cannot report a configuration with publication permission (${forbidden.join(', ')}); remove it from the control configuration`), { code: 'SETUP_REQUIRED' });
  }
}

/**
 * A blocking finding is attributable to an acceptance requirement when either
 * string quotes the other verbatim. This is intentionally deterministic; the
 * human-readable detail always carries the original finding text so the owner
 * can judge the relationship.
 */
function relatedFinding(finding: string, requirement: string): boolean {
  return finding.includes(requirement) || requirement.includes(finding);
}

function unreviewedReason(job: Job): string {
  return job.error ?? `Task status is ${job.status}${job.stage ? ` at stage ${job.stage}` : ''}; independent review has not run`;
}

function buildChecklist(job: Job): ChecklistEntry[] {
  const review = job.review;
  if (!review) {
    const reason = unreviewedReason(job);
    return job.spec.acceptance.map(requirement => ({ requirement, status: 'unreviewed' as const, evidence: null, reason }));
  }
  return job.spec.acceptance.map(requirement => {
    const matched = review.acceptanceEvidence.find(entry => entry.requirement === requirement);
    const related = review.approved === false ? review.findings.filter(finding => relatedFinding(finding, requirement)) : [];
    if (related.length > 0) return { requirement, status: 'failed' as const, evidence: matched?.evidence ?? null, reason: related.join('; ') };
    if (matched) {
      if (!job.verifiedDigest) return { requirement, status: 'unreviewed' as const, evidence: matched.evidence ?? null, reason: 'Source changed since verification; re-verification is required before this evidence can pass' };
      return { requirement, status: 'passed' as const, evidence: matched.evidence, reason: null };
    }
    return { requirement, status: 'uncovered' as const, evidence: null, reason: '评审证据未覆盖该验收项' };
  });
}

function blockedReasonDetail(blockedReason: NonNullable<Job['blockedReason']>): string {
  return `${blockedReason.kind} at ${blockedReason.stage}: ${blockedReason.prerequisite.reason}${blockedReason.prerequisite.path ? ` (${blockedReason.prerequisite.path})` : ''}`;
}

function buildFailures(job: Job, checklist: ChecklistEntry[]): FailureEntry[] {
  const failures: FailureEntry[] = [];
  const review = job.review;
  if (review && review.approved === false) {
    for (const finding of review.findings) {
      const requirement = job.spec.acceptance.find(req => relatedFinding(finding, req));
      failures.push({ item: 'review-finding', ...(requirement ? { requirement } : {}), detail: finding });
    }
  }
  if (job.error != null) failures.push({ item: 'job-error', detail: job.error });
  if (job.blockedReason) failures.push({ item: 'blocked', detail: blockedReasonDetail(job.blockedReason) });
  if (job.manualRecovery != null) failures.push({ item: 'blocked', detail: job.manualRecovery });
  for (const entry of checklist) {
    if (entry.status === 'failed') failures.push({ item: 'acceptance', requirement: entry.requirement, detail: entry.reason ?? '未通过' });
  }
  return failures;
}

function reportSource(job: Job, delivery: DeliveryManifest): ReportSource {
  const source: ReportSource = {
    projectRoot: delivery.projectRoot,
    sourcePath: delivery.sourcePath,
    executionPath: delivery.executionPath,
    recordedDigest: delivery.sourceDigest,
    currentDigest: null,
    verification: 'unverified',
    reason: 'No recorded source verification is linked to the current live project.',
  };
  try {
    assertPinnedProjectRoots(job);
    source.currentDigest = sourceDigest(job.projectRoot, true, job.spec.framework, job.spec.project?.directory);
  } catch (cause) {
    source.reason = `Current live source could not be fingerprinted: ${toError(cause).message}`;
    return source;
  }
  if (source.recordedDigest && source.currentDigest !== source.recordedDigest) {
    source.reason = 'Live source changed since the recorded verification or execution snapshot. Current source is unverified; recorded artifact and checklist evidence do not verify these changed bytes.';
  } else if (source.recordedDigest && delivery.verifiedDigest) {
    const sharedRoot = job.projectRoot === job.workspace;
    source.verification = sharedRoot ? 'matches-verification' : 'matches-execution-snapshot';
    source.reason = sharedRoot
      ? 'Current live source bytes match the recorded execution-source verification. This is a source fingerprint comparison, not a new runtime or dependency verification.'
      : 'Current live source bytes match the recorded pre-obfuscation execution snapshot. Verification and the artifact refer to the separate execution path, not a launch of this live project.';
  }
  return source;
}

export function buildReport(job: Job): Report {
  const checklist = buildChecklist(job);
  const delivery = deliveryManifest(job);
  const verified: ReportVerified = {
    sourceDigest: job.verifiedDigest ?? null,
    dependencyDigest: job.verifiedDependencyDigest ?? null,
    screenshotDigest: job.screenshotDigest ?? null,
    ...(job.verifiedAt !== undefined ? { verifiedAt: job.verifiedAt } : {}),
    ...(job.obfuscationDigest !== undefined ? { obfuscationDigest: job.obfuscationDigest } : {}),
    ...(job.obfuscationReport !== undefined ? { obfuscationReport: job.obfuscationReport } : {}),
  };
  return {
    job: {
      id: job.id,
      product: job.spec.id,
      version: job.spec.version,
      framework: job.spec.framework,
      platform: job.spec.platform,
      channel: job.spec.channel,
      status: job.status,
      stage: job.stage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      attempts: job.attempts,
      hostTurns: job.hostTurns,
    },
    decisions: job.decisions,
    ...(job.workflow !== undefined ? { workflow: job.workflow } : {}),
    ...(job.error != null ? { error: job.error } : {}),
    ...(job.feedback !== undefined ? { feedback: job.feedback } : {}),
    ...(job.blockedReason != null ? { blockedReason: job.blockedReason } : {}),
    ...(job.manualRecovery != null ? { manualRecovery: job.manualRecovery } : {}),
    verified,
    artifact: job.artifact ?? null,
    checklist,
    failures: buildFailures(job, checklist),
    source: reportSource(job, delivery),
    delivery,
    ...(job.review?.uiQuality ? { uiQuality: job.review.uiQuality } : {}),
  };
}

/** Export the maintainable project root, retaining monorepo-relative source paths. */
function collectSourceFiles(job: Job): Array<{ abs: string; rel: string }> {
  assertPinnedProjectRoots(job);
  const root = job.projectRoot;
  const framework = job.spec.framework;
  const directory = job.spec.project?.directory ?? '.';
  if (!existsSync(root)) throw new Error(`Live project is missing; there is no source to collect: ${root}`);
  if (lstatSync(root).isSymbolicLink()) throw new Error(`Project root cannot be a symlink: ${root}`);
  const moduleOutputs = generatedModulePaths(root, framework, directory);
  for (const output of moduleOutputs) inside(root, output);
  const project = sourceProjectDirectory(job);
  const files: Array<{ abs: string; rel: string }> = [];
  function visit(current: string): void {
    for (const entry of readdirSync(current).sort()) {
      const abs = join(current, entry);
      const workspacePath = relative(root, abs).split(sep).join('/');
      let generated = isGeneratedPath(workspacePath, framework)
        || (project !== root && !relative(project, abs).startsWith('..') && isGeneratedPath(relative(project, abs), framework));
      if (!generated) {
        for (const output of moduleOutputs) {
          if (workspacePath === output || workspacePath.startsWith(`${output}/`)) { generated = true; break; }
        }
      }
      if (generated) { inside(root, abs); continue; }
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) throw new Error(`Source symlink is not permitted: ${workspacePath}`);
      if (stat.isDirectory()) visit(abs);
      else if (stat.isFile()) files.push({ abs, rel: workspacePath });
      else throw new Error(`Source is not a regular file or directory: ${workspacePath}`);
    }
  }
  visit(root);
  return files;
}

function copySource(files: Array<{ abs: string; rel: string }>, destination: string): void {
  for (const file of files) {
    const target = join(destination, file.rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file.abs, target, { mode: constants.COPYFILE_FICLONE });
  }
}

function artifactDigest(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) throw new Error(`Artifact is missing: ${path}`);
  if (stat.isSymbolicLink()) throw new Error(`Artifact must not be a symlink: ${path}`);
  if (stat.isDirectory()) {
    if (readdirSync(path).length === 0) throw new Error(`Artifact is empty: ${path}`);
    return sourceDigest(path, false);
  }
  if (!stat.isFile()) throw new Error(`Artifact is not a regular file or directory: ${path}`);
  if (stat.size === 0) throw new Error(`Artifact is empty: ${path}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertArtifact(job: Job, path = job.artifact?.path): void {
  if (job.artifact && path && artifactDigest(path) !== job.artifact.digest) {
    throw new Error(`Artifact digest does not match the recorded artifact: ${path}`);
  }
}

function copyArtifact(job: Job, destination: string): string | null {
  const artifact = job.artifact;
  if (!artifact) return null;
  assertPinnedProjectRoots(job);
  const target = join(destination, basename(artifact.path));
  cpSync(artifact.path, target, { recursive: true, mode: constants.COPYFILE_FICLONE });
  assertArtifact(job, target);
  assertArtifact(job);
  return target;
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return !path || !(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path));
}

/** Inspect existing output entries before any mkdir, report write or copy. */
function assertOutputEntry(path: string, directory?: boolean): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`Report output must not use a symlink: ${path}`);
  if (stat.isFile()) {
    if (directory === true) throw new Error(`Expected a report output directory: ${path}`);
    if (stat.nlink > 1) throw new Error(`Report output must not overwrite a hard-linked file: ${path}`);
  } else if (stat.isDirectory()) {
    if (directory === false) throw new Error(`Expected a report output file: ${path}`);
    for (const entry of readdirSync(path)) assertOutputEntry(join(path, entry));
  } else {
    throw new Error(`Report output is not a regular file or directory: ${path}`);
  }
}

function assertReportOutput(job: Job, outDir: string, config: Config, reportPath: string, markdownPath: string, collectDir?: string): void {
  const output = canonicalPath(outDir);
  const configs = config === job.config ? [job.config] : [job.config, config];
  const protectedPaths = new Set([
    job.projectRoot, job.workspace, ...(job.sourceDirectory ? [job.sourceDirectory] : []),
    ...configs.flatMap(value => [value.workspaceRoot, ...(value.projectMode === 'project' && value.projectRoot ? [value.projectRoot] : []), ...(value.inbox ? [value.inbox.directory] : []), ...(value.configPath ? [value.configPath] : [])]),
    ...(job.artifact ? [job.artifact.path] : []),
  ]);
  for (const path of protectedPaths) {
    const reserved = canonicalPath(path);
    if (contains(output, reserved) || contains(reserved, output)) throw new Error(`Report output must not overlap source, execution, artifact, control or inbox paths: ${path}`);
  }
  for (const value of configs) {
    const state = canonicalPath(value.stateDir);
    // Results are the sole writable subtree of control state. Resolve the state
    // first so a results symlink cannot redirect that exception into the queue.
    const results = join(state, 'results');
    if ((contains(output, state) || contains(state, output)) && !contains(results, output)) throw new Error(`Report output inside stateDir is restricted to stateDir/results: ${value.stateDir}`);
  }
  const stat = lstatSync(outDir, { throwIfNoEntry: false });
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Report output must be a real directory: ${outDir}`);
  assertOutputEntry(reportPath, false);
  assertOutputEntry(markdownPath, false);
  if (collectDir) assertOutputEntry(collectDir, true);
}

const STATUS_LABEL: Record<ChecklistStatus, string> = {
  passed: '✅ 通过',
  uncovered: '❌ 未覆盖',
  failed: '⛔ 不通过',
  unreviewed: '⏳ 未评审',
};

function md(value: unknown): string {
  return String(value).replaceAll('|', '\\|');
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function renderMarkdown(report: Report): string {
  const job = report.job;
  const lines: string[] = [`# Handoff report — ${job.id}`, ''];
  lines.push('## Job', '', '| Field | Value |', '| --- | --- |');
  for (const [key, value] of [
    ['id', job.id], ['product', job.product], ['version', job.version], ['framework', job.framework],
    ['platform', job.platform], ['channel', job.channel], ['status', job.status], ['stage', job.stage],
    ['createdAt', iso(job.createdAt)], ['updatedAt', iso(job.updatedAt)], ['attempts', JSON.stringify(job.attempts)], ['hostTurns', String(job.hostTurns)],
  ] as Array<[string, string]>) lines.push(`| ${key} | ${md(value)} |`);
  lines.push('', '## Recorded artifact', '');
  if (report.artifact) {
    lines.push(`- **kind**: ${md(report.artifact.kind)}`);
    lines.push(`- **path**: ${md(report.artifact.path)}`);
    lines.push(`- **digest**: ${md(report.artifact.digest)}`);
    lines.push(`- **createdAt**: ${md(report.artifact.createdAt)}`);
  } else {
    lines.push('None');
  }
  lines.push('', '## Source', '',
    `- **projectRoot** (primary maintainable project): ${md(report.source.projectRoot)}`,
    `- **sourcePath** (live app directory): ${md(report.source.sourcePath)}`,
    `- **executionPath** (recorded verification / packaging directory): ${md(report.source.executionPath)}`,
    `- **recorded sourceDigest** (project-root fingerprint): ${md(report.source.recordedDigest ?? 'None')}`,
    `- **current sourceDigest** (project-root fingerprint): ${md(report.source.currentDigest ?? 'Unavailable')}`,
    `- **verifiedDigest** (recorded execution-root fingerprint): ${md(report.delivery.verifiedDigest ?? 'None')}`,
    `- **current source linkage**: ${report.source.verification}`,
    `- ${md(report.source.reason)}`,
    '', 'A collected source export is a secondary snapshot, not the primary project.');
  lines.push('', '## Owner-configured runtime acceptance commands', '',
    'These are the frozen runtime acceptance commands, not an invented launch command, a new verified run or a published link.',
    `- **cwd**: ${md(report.delivery.runtime.cwd)}`,
    `- **environment variable names** (values are not included): ${md(report.delivery.runtime.environment.join(', ') || 'None')}`);
  for (const argv of report.delivery.runtime.commands) lines.push(`- **argv**: ${md(JSON.stringify(argv))}`);
  lines.push('', '## Checklist', '', 'The following is recorded review evidence for the execution source. It does not independently verify the current live project or a collected export.', '', '| 验收项 | 状态 | 证据 / 原因 |', '| --- | --- | --- |');
  for (const entry of report.checklist) {
    lines.push(`| ${md(entry.requirement)} | ${STATUS_LABEL[entry.status]} | ${md(entry.evidence ?? entry.reason ?? '')} |`);
  }
  if (report.uiQuality) {
    lines.push('', '## Recorded platform UI review', '', 'Reviewer observations and captured bytes bound to the recorded verification, not an automatic aesthetic or frame-rate guarantee.', '', '| Check | Result | Observation | Captures |', '| --- | --- | --- | --- |');
    for (const check of report.uiQuality.checks) lines.push(`| ${md(check.id)} | ${check.status} | ${md(check.observation)} | ${md(check.capturePaths.join(', '))} |`);
    for (const capture of report.uiQuality.captures) lines.push(`- ${md(capture.kind)} ${md(capture.path)} — ${capture.viewport.width}×${capture.viewport.height}, ${md(capture.device)}, ${md(capture.state)}; SHA-256 ${capture.sha256}`);
  }
  if (report.workflow) {
    lines.push('', '## Workflow', '', `- **cancelled**: ${report.workflow.cancelled}`);
    for (const stage of ['research', 'build', 'review'] as const) {
      const phase = report.workflow.phases[stage];
      if (!phase) continue;
      lines.push('', `### ${stage} — revision ${phase.revision}`, '', `- **status**: ${phase.status}`, `- **reason**: ${md(phase.reason)}`, `- **final**: ${md(phase.final ?? 'Not planned')}`);
      lines.push('', '| Node | Role | Status | Attempts | Dependencies | Read paths | Write paths |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const node of phase.nodes) {
        const definition = node.definition;
        lines.push(`| ${md(definition.id)} | ${md(definition.role)} | ${node.status} | ${node.attempts} | ${md(definition.dependsOn.join(', ') || 'None')} | ${md(definition.readPaths.join(', ') || 'None')} | ${md(definition.writePaths.join(', ') || 'None')} |`);
      }
      for (const node of phase.nodes) {
        const definition = node.definition;
        lines.push('', `#### ${md(definition.id)} — ${node.status}`, '', `- **instructions**: ${md(definition.instructions)}`, `- **declared context**: ${definition.fresh ? 'fresh' : 'host-managed'}${definition.provider ? `; declared provider=${md(definition.provider)}` : ''} (host-executed; not identity attestation)`);
        if (node.turn) lines.push(`- **active turn**: ${md(node.turn.id)} (revision ${node.turn.planRevision ?? phase.revision})`);
        if (node.completedAt !== undefined) lines.push(`- **completedAt**: ${iso(node.completedAt)}`);
        if (node.result) lines.push(`- **result**: ${node.result.outcome} — ${md(node.result.summary)}`);
        lines.push('', '**Acceptance evidence**', '');
        for (const requirement of definition.acceptance) {
          const evidence = node.result?.evidence.find(entry => entry.requirement === requirement);
          lines.push(`- **${md(requirement)}**: ${md(evidence?.evidence ?? 'Not yet observed')}`);
        }
        for (const evidence of node.result?.evidence ?? []) {
          if (!definition.acceptance.includes(evidence.requirement)) lines.push(`- **${md(evidence.requirement)}** (additional evidence): ${md(evidence.evidence)}`);
        }
        if (node.result?.result !== undefined) {
          lines.push('', '**Structured output**', '', ...JSON.stringify(node.result.result, null, 2).split('\n').map(line => `    ${line}`));
        }
      }
      lines.push('', '**Plan revision history**', '');
      if (phase.history.length === 0) lines.push('No accepted plan yet.');
      for (const entry of phase.history) {
        lines.push(`- **revision ${entry.revision}** (${iso(entry.at)}): ${md(entry.reason)}`, `  - rationale: ${md(entry.plan.rationale)}`, `  - final: ${md(entry.plan.final)}; nodes: ${md(entry.plan.nodes.map(node => node.id).join(', '))}; invalidated: ${md(entry.plan.invalidate.join(', ') || 'None')}`);
      }
    }
  }
  lines.push('', '## 决策日志', '');
  if (report.decisions.length === 0) {
    lines.push('无');
  } else {
    for (const decision of report.decisions) {
      const labels = [decision.stage ? `stage=${decision.stage}` : '', decision.role ? `role=${decision.role}` : ''].filter(Boolean).join(' ');
      lines.push(`- \`${md(iso(decision.at))}\`${labels ? ` (${md(labels)})` : ''}：${md(decision.rationale)}`);
    }
  }
  lines.push('', '## 不通过项与原因', '');
  if (report.failures.length === 0) {
    lines.push('无');
  } else {
    for (const failure of report.failures) {
      const requirement = failure.requirement ? `（${failure.requirement}）` : '';
      lines.push(`- **${failure.item}**${requirement}：${failure.detail}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function reportJob(store: Store, id: string, options: ReportOptions = {}): ReportSummary {
  const job = store.get(id);
  const config = options.config ?? job.config;
  if (options.buildOnly) assertBuildOnly(config);
  if (options.collect) assertPinnedProjectRoots(job);
  const control = config.configPath ? dirname(config.configPath) : process.cwd();
  const outDir = options.out === undefined ? resolve(config.stateDir, 'results') : resolve(control, options.out);
  const reportPath = join(outDir, `${id}-report.json`);
  const markdownPath = join(outDir, `${id}-report.md`);
  const collectDir = options.collect ? join(outDir, id) : undefined;
  assertReportOutput(job, outDir, config, reportPath, markdownPath, collectDir);
  const report = buildReport(job);
  const files = collectDir ? collectSourceFiles(job) : [];
  if (collectDir) {
    if (report.source.currentDigest === null) throw new Error(`Cannot collect live source without a consistent fingerprint: ${report.source.reason}`);
    if (job.artifact && basename(job.artifact.path) === 'source') throw new Error('Collected artifact would collide with the source snapshot directory');
    assertArtifact(job);
    const sourceDir = join(collectDir, 'source');
    if (existsSync(sourceDir)) {
      const expected = new Set<string>();
      for (const file of files) {
        let path = file.rel;
        while (path !== '.') {
          expected.add(path);
          path = dirname(path);
        }
      }
      for (const entry of readdirSync(sourceDir, { recursive: true, encoding: 'utf8' })) {
        if (!expected.has(entry.split(sep).join('/'))) throw new Error(`Collected source contains stale files; use a fresh --out directory: ${join(sourceDir, entry)}`);
      }
    }
  }
  mkdirSync(outDir, { recursive: true });
  accessSync(outDir, constants.W_OK);
  let collect: ReportSummary['collect'];
  if (collectDir) {
    assertPinnedProjectRoots(job);
    const sourceDir = join(collectDir, 'source');
    mkdirSync(sourceDir, { recursive: true });
    copySource(files, sourceDir);
    const exportedDigest = sourceDigest(sourceDir, true, job.spec.framework, job.spec.project?.directory);
    assertPinnedProjectRoots(job);
    const currentDigest = sourceDigest(job.projectRoot, true, job.spec.framework, job.spec.project?.directory);
    if (exportedDigest !== report.source.currentDigest || currentDigest !== report.source.currentDigest) {
      throw new Error('Live source changed during collection; the exported snapshot cannot be linked to this report.');
    }
    const artifact = copyArtifact(job, collectDir);
    collect = { source: sourceDir, artifact, role: 'secondary-source-snapshot', sourceDigest: exportedDigest };
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, renderMarkdown(report), 'utf8');
  const checklist: Record<ChecklistStatus, number> = { passed: 0, failed: 0, uncovered: 0, unreviewed: 0 };
  for (const entry of report.checklist) checklist[entry.status] += 1;
  return { report: reportPath, markdown: markdownPath, delivery: report.delivery, checklist, failures: report.failures.length, ...(collect ? { collect } : {}) };
}
