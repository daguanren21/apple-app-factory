import { ResearchSchema } from './schemas.js';
import type { Job, Spec } from './schemas.js';

export function parseResearch(text: string, channel: Spec['channel']) {
  const content = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new Error('Host did not return a JSON verdict; no approval was inferred from text or an exit code'); }
  return ResearchSchema.parse(value);
}

/** Honest pre-delivery differentiation and quality checklist. Store submission and review stay manual. */
export function internalQaChecklist(): string {
  return [
    
  ].join('\n');
}

export function researchPrompt(job: Job, portfolio: Array<Pick<Spec, 'id' | 'purpose' | 'audience' | 'differentiators'>>): string {
  const siblings = `Other same-channel products ${JSON.stringify(portfolio)}; earlier versions of this same app are its source baseline, not competing products.`;
  return `Research only with your own host tools. Preserve the requested ${job.spec.framework} ${job.spec.platform} project and its existing architecture. ${internalQaChecklist()} ${siblings} Assess technical feasibility, dependencies, licensing, privacy and real acceptance for this local package. Return typed JSON {"viable":boolean,"distinctness":"specific honest differentiation","risks":["..."],"plan":["concrete implementation and device acceptance step"]}. Do not promise store approval and do not add unrequested features.`;
}

export function reviewInstructions(job: Job): string {
  return `Use an independent reviewer with fresh context when supported; otherwise disclose the limitation. Review actual source and acceptance read-only. Verified source: ${job.verifiedDigest}; dependency resolution: ${job.verifiedDependencyDigest}; actual checks: ${JSON.stringify(job.config.verification)}. ${internalQaChecklist()} Reject incomplete requirements, data loss, fake screenshots, accessibility failures, placeholders, weak tests and hidden features. Return typed JSON {"approved":boolean,"findings":["blocking issue"],"acceptanceEvidence":[{"requirement":"exact acceptance string","evidence":"file/symbol + observed command or device scenario"}]}. Cover every acceptance requirement. Reviewer identity is advisory; the Harness gates typed results and unchanged execution evidence.`;
}
