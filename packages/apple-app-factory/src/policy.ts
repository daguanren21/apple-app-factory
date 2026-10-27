import { ResearchSchema } from './schemas.js';
import type { Job, Spec } from './schemas.js';

const APPLE_RULES = ['2.1', '2.3.1', '2.5.19', '4.2', '4.2.6', '4.3', '5.1.1'];
const PLAY_RULES = ['repetitive-content', 'user-data'];

export function parseResearch(text: string, channel: Spec['channel']) {
  const content = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  let value: unknown;
  try { value = JSON.parse(content); }
  catch { throw new Error('Host did not return a JSON verdict; no approval was inferred from text or an exit code'); }
  const research = ResearchSchema.parse(value);
  const required = channel === 'app-store' ? APPLE_RULES : channel === 'google-play' ? PLAY_RULES : [];
  const cited = new Set<string>();
  for (const source of research.policySources) {
    const url = new URL(source.url);
    const official = channel === 'app-store'
      ? url.hostname === 'developer.apple.com' && url.pathname.startsWith('/app-store/review/guidelines')
      : url.hostname === 'support.google.com' && url.pathname.startsWith('/googleplay/android-developer/');
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && official) cited.add(source.rule);
  }
  if (!required.every(rule => cited.has(rule))) throw new Error(`Research verdict requires official HTTPS policy references for ${channel}: ${required.join(', ')}`);
  return research;
}

export function researchPrompt(job: Job, portfolio: Array<Pick<Spec, 'id' | 'purpose' | 'audience' | 'differentiators'>>): string {
  const policy = job.spec.channel === 'app-store'
    ? `Read the current official Apple review guidelines at https://developer.apple.com/app-store/review/guidelines/ and assess rules ${APPLE_RULES.join(', ')}. Assess actual content ownership and submitting-account eligibility under 4.2.6; unknown attestations require the owner. Compare meaningful user value against the same-channel portfolio ${JSON.stringify(portfolio)}. Cite every listed rule using the official HTTPS guidelines URL.`
    : job.spec.channel === 'google-play'
      ? `Read current Google Play policies: https://support.google.com/googleplay/android-developer/answer/9899034 and https://support.google.com/googleplay/android-developer/answer/10144311 . Assess repetitive content and user data/privacy with policySources rules ${PLAY_RULES.join(', ')} and official HTTPS Play policy URLs. Compare actual user value against the same-channel portfolio ${JSON.stringify(portfolio)}. APK testing is not AAB store acceptance. This channel produces a verified local handoff; automatic Google Play submission is not enabled.`
      : 'This is local artifact delivery, not a store submission. Do not impose Apple or Google Play admission rules, submitting-account requirements or portfolio exclusivity. Research technical feasibility, dependencies, licensing, privacy and the actual product acceptance. No store policy citations are required; policySources may be empty.';
  return `Research only with your own host tools. Preserve the requested ${job.spec.framework} ${job.spec.platform} project and its existing architecture. ${policy} Do not promise store approval. Return typed JSON {"viable":boolean,"policySources":[{"rule":"exact rule","url":"https://official-source/..."}],"distinctness":"specific value and channel reasoning","risks":["..."],"plan":["concrete implementation and device acceptance step"]}. Citations supplied by the host are not independently verified policy evidence. Do not add unrequested product features.`;
}
