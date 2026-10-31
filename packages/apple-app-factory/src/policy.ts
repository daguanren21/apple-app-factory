import { ResearchSchema } from './schemas.js';
import type { Job, Spec } from './schemas.js';

export function parseResearch(text: string, channel: Spec['channel']) {
  const content = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new Error('Host did not return a JSON verdict; no approval was inferred from text or an exit code'); }
  return ResearchSchema.parse(value);
}

export function researchPrompt(job: Job, portfolio: Array<Pick<Spec, 'id' | 'purpose' | 'audience' | 'differentiators'>>): string {
  const siblings = `Other same-channel products ${JSON.stringify(portfolio)}; earlier versions of this same app are its source baseline, not competing products.`;
  return `Research only with your own host tools. Preserve the requested ${job.spec.framework} ${job.spec.platform} project and its existing architecture. ${siblings} Assess technical feasibility, dependencies, licensing, privacy and real acceptance for this local package. Return typed JSON {"viable":boolean,"distinctness":"specific honest differentiation","risks":["..."],"plan":["concrete implementation and device acceptance step"]}. Do not promise store approval and do not add unrequested features.`;
}

export function reviewInstructions(job: Job): string {
  return `Use an independent reviewer with fresh non-implementer context. If the host cannot supply it, disclose the missing capability and defer; disclosure does not satisfy independence and must never be submitted as a passing review. Review actual source and acceptance read-only. Verified source: ${job.verifiedDigest}; dependency resolution: ${job.verifiedDependencyDigest}; actual checks: ${JSON.stringify(job.config.verification)}. Reject incomplete requirements, data loss, fake screenshots, accessibility failures, placeholders, weak tests and hidden features. When docs/ui-design.md exists, verify the implementation against that design spec (colors, type scale, spacing, component states, layout) and treat any inconsistency as a blocking issue. The architect-review seat additionally blocks on design smells — repeated workarounds, any/forced-cast types, broken module boundaries, or multi-writer state — and every finding must name the specific file(s). Return typed JSON {"approved":boolean,"findings":["blocking issue"],"acceptanceEvidence":[{"requirement":"exact acceptance string","evidence":"file/symbol + observed command or device scenario"}]}. A dynamic specialist covers its assigned criteria; final review must cover every product acceptance requirement and cannot discard another review node's explicit rejection. Reviewer identity is host-attested, not authenticated by the CLI; typed results and unchanged execution evidence remain mandatory.`;
}
