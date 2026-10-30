import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResearch } from '../dist/policy.js';

function research() {
  return {
    viable: true,
    distinctness: 'Independent multi-bag planning and return reconciliation; publisher ownership must be established before submission.',
    risks: ['No App Review outcome is guaranteed.'],
    plan: ['Implement and exercise the actual offline workflow.'],
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

