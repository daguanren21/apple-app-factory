import { accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { inside } from './config.js';
import { generatedModulePaths, isGeneratedPath } from './dependencies.js';
import type { Config, Job } from './schemas.js';
import type { Store } from './store.js';
import { projectDirectory } from './workspace.js';

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
  error?: string | null;
  feedback?: string;
  blockedReason?: NonNullable<Job['blockedReason']>;
  manualRecovery?: string | null;
  verified: ReportVerified;
  artifact: Job['artifact'] | null;
  checklist: ChecklistEntry[];
  failures: FailureEntry[];
  source: { workspace: string; verifiedDigest: string | null };
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
  checklist: Record<ChecklistStatus, number>;
  failures: number;
  collect?: { source: string; artifact: string | null };
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
    if (matched) return { requirement, status: 'passed' as const, evidence: matched.evidence, reason: null };
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

export function buildReport(job: Job): Report {
  const checklist = buildChecklist(job);
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
    ...(job.error != null ? { error: job.error } : {}),
    ...(job.feedback !== undefined ? { feedback: job.feedback } : {}),
    ...(job.blockedReason != null ? { blockedReason: job.blockedReason } : {}),
    ...(job.manualRecovery != null ? { manualRecovery: job.manualRecovery } : {}),
    verified,
    artifact: job.artifact ?? null,
    checklist,
    failures: buildFailures(job, checklist),
    source: { workspace: job.workspace, verifiedDigest: job.verifiedDigest ?? null },
  };
}

/** Files covered by sourceDigest: the workspace minus generated outputs and symlinks. */
function collectSourceFiles(job: Job): Array<{ abs: string; rel: string }> {
  const root = job.workspace;
  const framework = job.spec.framework;
  const directory = job.spec.project?.directory ?? '.';
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) throw new Error(`Workspace root cannot be a symlink: ${root}`);
  const moduleOutputs = generatedModulePaths(root, framework, directory);
  for (const output of moduleOutputs) inside(root, output);
  const project = projectDirectory(job);
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

function copySource(job: Job, destination: string): void {
  for (const file of collectSourceFiles(job)) {
    const target = join(destination, file.rel);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(file.abs, target, { mode: constants.COPYFILE_FICLONE });
  }
}

function copyArtifact(job: Job, destination: string): string | null {
  const artifact = job.artifact;
  if (!artifact) return null;
  const source = artifact.path;
  const target = join(destination, basename(source));
  const stat = lstatSync(source, { throwIfNoEntry: false });
  if (!stat) throw new Error(`Artifact is missing: ${source}`);
  if (stat.isSymbolicLink()) throw new Error(`Artifact must not be a symlink: ${source}`);
  if (stat.isDirectory()) {
    cpSync(source, target, { recursive: true, mode: constants.COPYFILE_FICLONE });
    if (readdirSync(target).length === 0) throw new Error(`Copied artifact is empty: ${target}`);
  } else if (stat.isFile()) {
    cpSync(source, target, { mode: constants.COPYFILE_FICLONE });
    if (statSync(target).size === 0) throw new Error(`Copied artifact is empty: ${target}`);
  } else {
    throw new Error(`Artifact is not a regular file or directory: ${source}`);
  }
  return target;
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
  lines.push('', '## Artifact', '');
  if (report.artifact) {
    lines.push(`- **kind**: ${md(report.artifact.kind)}`);
    lines.push(`- **path**: ${md(report.artifact.path)}`);
    lines.push(`- **digest**: ${md(report.artifact.digest)}`);
    lines.push(`- **createdAt**: ${md(report.artifact.createdAt)}`);
  } else {
    lines.push('None');
  }
  lines.push('', '## Source', '', `- **workspace**: ${md(report.source.workspace)}`, `- **verifiedDigest**: ${md(report.source.verifiedDigest ?? '')}`);
  lines.push('', '## Checklist', '', '| 验收项 | 状态 | 证据 / 原因 |', '| --- | --- | --- |');
  for (const entry of report.checklist) {
    lines.push(`| ${md(entry.requirement)} | ${STATUS_LABEL[entry.status]} | ${md(entry.evidence ?? entry.reason ?? '')} |`);
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
  if (options.buildOnly) assertBuildOnly(options.config);
  const control = options.config?.configPath ? dirname(options.config.configPath) : process.cwd();
  const outDir = resolve(control, options.out ?? 'results');
  mkdirSync(outDir, { recursive: true });
  accessSync(outDir, constants.W_OK);
  const report = buildReport(job);
  const reportPath = join(outDir, `${id}-report.json`);
  const markdownPath = join(outDir, `${id}-report.md`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(markdownPath, renderMarkdown(report), 'utf8');
  const checklist: Record<ChecklistStatus, number> = { passed: 0, failed: 0, uncovered: 0, unreviewed: 0 };
  for (const entry of report.checklist) checklist[entry.status] += 1;
  let collect: ReportSummary['collect'];
  if (options.collect) {
    const collectDir = join(outDir, id);
    mkdirSync(collectDir, { recursive: true });
    const sourceDir = join(collectDir, 'source');
    mkdirSync(sourceDir, { recursive: true });
    copySource(job, sourceDir);
    const artifact = copyArtifact(job, collectDir);
    collect = { source: sourceDir, artifact };
  }
  return { report: reportPath, markdown: markdownPath, checklist, failures: report.failures.length, ...(collect ? { collect } : {}) };
}
