import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResearch, internalQaChecklist, researchPrompt, reviewInstructions } from '../dist/policy.js';

function research() {
  return {
    viable: true,
    distinctness: 'Independent multi-bag planning and return reconciliation; publisher ownership must be established before submission.',
    risks: ['No App Review outcome is guaranteed.'],
    plan: ['Implement and exercise the actual offline workflow.'],
  };
}

function job(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    spec: {
      id: 'pack-balance', name: 'Pack Balance', framework: 'flutter', platform: 'ios', channel: 'app-store',
      version: '1.0.0', differentiators: ['Real offline workflow'], acceptance: ['Real device acceptance'],
      purpose: 'Plan luggage', audience: 'Travelers',
    },
    ...overrides,
  };
}

test('a research verdict requires honest differentiation and an actionable plan', () => {
  const valid = research();
  assert.equal(parseResearch(JSON.stringify(valid), 'app-store').viable, true);
  for (const mutate of [
    input => { input.viable = 'true'; },
    input => { input.plan = []; },
    input => { input.plan = [null]; },
    input => { delete input.distinctness; },
    input => { input.distinctness = ''; },
  ]) {
    const input = research();
    mutate(input);
    assert.throws(() => parseResearch(JSON.stringify(input), 'app-store'));
  }
});

test('research rejects non-JSON verdicts instead of inferring approval from text', () => {
  assert.throws(() => parseResearch('The product looks good, ship it.', 'app-store'));
  assert.throws(() => parseResearch('{viable:true}', 'app-store'));
});

test('App Store research is honest differentiation without policy citations or audits', () => {
  const withPolicySources = { ...research(), policySources: [{ rule: '2.1', url: 'https://developer.apple.com/app-store/review/guidelines/' }] };
  assert.throws(() => parseResearch(JSON.stringify(withPolicySources), 'app-store'));
  const withAudit = { ...research(), appStoreAudit: { policyUrl: 'https://developer.apple.com/app-store/review/guidelines/', checks: [] } };
  assert.throws(() => parseResearch(JSON.stringify(withAudit), 'app-store'));
  assert.equal(parseResearch(JSON.stringify(research()), 'local').viable, true);
  assert.equal(parseResearch(JSON.stringify(research()), 'google-play').viable, true);
});

test('the internal QA checklist keeps the honest differentiation and identity safeguards', () => {
  const checklist = internalQaChecklist();
  assert.match(checklist, /Store submission, account setup and platform review are manual human work outside this tool/);
  assert.match(checklist, /nothing here bypasses, influences or pre-approves a store reviewer/);
  assert.match(checklist, /Never forge identities, accounts, locations or submission sources/);
  assert.match(checklist, /Do not mutate hashes, names or resource bytes solely to defeat similarity checks/);
  assert.match(checklist, /independent review must cover every frozen acceptance requirement with observed evidence/);
});

test('research prompts demand honest differentiation and never promise store approval', () => {
  const prompt = researchPrompt(job(), []);
  assert.match(prompt, /"distinctness":"specific honest differentiation"/);
  assert.match(prompt, /Do not promise store approval/);
  assert.match(prompt, /Do not promise store approval and do not add unrequested features/);
});

test('review instructions require observed evidence for every acceptance requirement', () => {
  const instructions = reviewInstructions(job({ verifiedDigest: 'a'.repeat(64), verifiedDependencyDigest: 'b'.repeat(64), config: { verification: { prerequisites: [], checks: [['true']], runtime: [['true']] } } }));
  assert.match(instructions, /Cover every acceptance requirement/);
  assert.match(instructions, /"approved":boolean,"findings"/);
  assert.match(instructions, /acceptanceEvidence/);
  assert.match(instructions, /Reject incomplete requirements, data loss, fake screenshots/);
});
