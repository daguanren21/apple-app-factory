import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResearch } from '../dist/runner.js';

function assessment() {
  return {
    viable: true,
    policySources: ['2.1', '2.3.1', '2.5.19', '4.2', '4.2.6', '4.3', '5.1.1'].map(rule => ({ rule, url: 'https://developer.apple.com/app-store/review/guidelines/' })),
    distinctness: 'Independent multi-bag planning and return reconciliation; publisher ownership must be established before submission.',
    risks: ['No App Review outcome is guaranteed.'],
    plan: ['Implement and exercise the actual offline workflow.'],
  };
}

test('a viable assessment cannot bypass the commercial app-generation rule', () => {
  const input = assessment();
  input.policySources = input.policySources.filter(source => source.rule !== '4.2.6');
  assert.throws(() => parseResearch(JSON.stringify(input)));
});

test('required policy evidence must use the official HTTPS origin', () => {
  for (const url of ['http://developer.apple.com/app-store/review/guidelines/', 'https://developer.apple.com.example.org/app-store/review/guidelines/']) {
    const input = assessment();
    input.policySources.find(source => source.rule === '4.2.6').url = url;
    assert.throws(() => parseResearch(JSON.stringify(input)));
  }
});

test('malformed research viability or a non-actionable plan is rejected rather than treated as an approved task', () => {
  const wrongType = assessment();
  wrongType.viable = 'true';
  assert.throws(() => parseResearch(JSON.stringify(wrongType)));
  const missingPlan = assessment();
  missingPlan.plan = [null];
  assert.throws(() => parseResearch(JSON.stringify(missingPlan)));
});
