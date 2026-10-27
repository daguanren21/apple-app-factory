import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResearch } from '../dist/policy.js';

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
  assert.throws(() => parseResearch(JSON.stringify(input), 'app-store'));
});

test('required policy evidence must use the official HTTPS origin', () => {
  for (const url of ['http://developer.apple.com/app-store/review/guidelines/', 'https://developer.apple.com.example.org/app-store/review/guidelines/']) {
    const input = assessment();
    input.policySources.find(source => source.rule === '4.2.6').url = url;
    assert.throws(() => parseResearch(JSON.stringify(input), 'app-store'));
  }
});

test('malformed research viability or a non-actionable plan is rejected rather than treated as an approved task', () => {
  const wrongType = assessment();
  wrongType.viable = 'true';
  assert.throws(() => parseResearch(JSON.stringify(wrongType), 'app-store'));
  const missingPlan = assessment();
  missingPlan.plan = [null];
  assert.throws(() => parseResearch(JSON.stringify(missingPlan), 'app-store'));
});

test('local research requires an actionable assessment but no Apple or Google policy citations', () => {
  const local = { ...assessment(), policySources: [] };
  assert.equal(parseResearch(JSON.stringify(local), 'local').viable, true);
  assert.throws(() => parseResearch(JSON.stringify({ ...local, viable: 'true' }), 'local'));
  assert.throws(() => parseResearch(JSON.stringify({ ...local, plan: [] }), 'local'));
});

test('Google Play research requires both official policy topics rather than Apple citations', () => {
  const google = { ...assessment(), policySources: ['repetitive-content', 'user-data'].map(rule => ({ rule, url: 'https://support.google.com/googleplay/android-developer/answer/9899034' })) };
  assert.equal(parseResearch(JSON.stringify(google), 'google-play').viable, true);
  assert.throws(() => parseResearch(JSON.stringify(assessment()), 'google-play'));
  for (const missing of ['repetitive-content', 'user-data']) {
    assert.throws(() => parseResearch(JSON.stringify({ ...google, policySources: google.policySources.filter(source => source.rule !== missing) }), 'google-play'));
  }
  for (const url of ['http://support.google.com/googleplay/android-developer/answer/9899034', 'https://support.google.com.example.org/googleplay/android-developer/answer/9899034', 'https://support.google.com/unrelated/answer/9899034']) {
    assert.throws(() => parseResearch(JSON.stringify({ ...google, policySources: google.policySources.map(source => ({ ...source, url })) }), 'google-play'));
  }
});
