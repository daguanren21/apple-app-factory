import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '@earendil-works/pi-schema';
import { ConfigSchema, JobSchema, SpecSchema, WorkflowPlanSchema } from '../dist/contracts/schemas.js';
import { defineContract, isoDateTimeSchema } from '../dist/contracts/validation.js';

const config = () => ({ stateDir: '/owned/state', workspaceRoot: '/owned/work', packageTarget: 'simulator',
  verification: { checks: [['node', '--version']], runtime: [['node', '--version']] } });
const spec = () => ({ id: 'contract-boundary', name: 'Boundary', framework: 'flutter', platform: 'ios', purpose: 'Preserve consumer parsing behavior', audience: 'Maintainers', differentiators: ['No coercion'], acceptance: ['Keep immutable input and real validation'] });

test('native parsing fills independent nested defaults without mutating a frozen owner input', () => {
  const input = config();
  input.workflow = Object.freeze({});
  input.roles = Object.freeze({ build: Object.freeze([{ name: 'developer' }]) });
  Object.freeze(input.verification.checks[0]); Object.freeze(input.verification.checks); Object.freeze(input.verification);
  Object.freeze(input);
  const parsed = ConfigSchema.parse(input);
  assert.equal(parsed.allowLocalExecution, false);
  assert.equal(parsed.workflow.maxParallel, 4);
  assert.equal(parsed.roles.build[0].fresh, false);
  assert.deepEqual(parsed.verification.prerequisites, []);
  parsed.roles.build[0].name = 'changed locally';
  parsed.executionEnv.push('OWNER_SETTING');
  const again = ConfigSchema.parse(input);
  assert.equal(again.roles.build[0].name, 'developer');
  assert.deepEqual(again.executionEnv, []);
  assert.deepEqual(input.workflow, {});
});

test('native structural validation never coerces execution flags, nulls or numeric strings', () => {
  for (const patch of [{ allowLocalExecution: 'true' }, { allowCloudBuild: 1 }, { maxAttempts: '8' }, { pollMs: null }, { workflow: { maxParallel: '4' } }]) {
    assert.equal(ConfigSchema.safeParse({ ...config(), ...patch }).success, false);
  }
  const explicit = ConfigSchema.parse({ ...config(), allowLocalExecution: false, workflow: { maxReplans: 0 } });
  assert.equal(explicit.allowLocalExecution, false);
  assert.equal(explicit.workflow.maxReplans, 0);
});

test('schema serialization remains native JSON Schema and checks parsed model-plan values without code generation', () => {
  const input = { rationale: 'Inspect one real scope', nodes: [{ id: 'inspect', role: 'observer', instructions: 'Inspect source only', acceptance: ['Observe source'] }], final: 'inspect' };
  const parsed = WorkflowPlanSchema.parse(input);
  const native = JSON.parse(JSON.stringify(WorkflowPlanSchema.schema));
  assert.equal(compile(native).check(parsed), true);
  assert.deepEqual(parsed.nodes[0].dependsOn, []);
  assert.deepEqual(parsed.nodes[0].readPaths, ['.']);
  assert.equal(parsed.nodes[0].fresh, false);
  assert.equal(compile(native).check({ ...parsed, unexpected: true }), false);
});

test('UTC timestamp contract preserves calendar and second-precision requirements', () => {
  const timestamp = defineContract(isoDateTimeSchema());
  for (const valid of ['2024-02-29T12:34:56Z', '0000-02-29T00:00:00Z', '2026-11-02T01:02:03.123456Z']) assert.equal(timestamp.parse(valid), valid);
  for (const invalid of ['2023-02-29T12:34:56Z', '2026-11-02T01:02Z', '2026-11-02T24:00:00Z', '2026-11-02T01:02:03+00:00']) assert.equal(timestamp.safeParse(invalid).success, false);
});

test('embedded contracts preserve semantic checks and passthrough data without prototype pollution', () => {
  const input = { id: 'job', spec: spec(), requestSpec: spec(), config: config(), stage: 'research', status: 'queued', createdAt: 1, updatedAt: 1, nextAt: 1,
    attempts: {}, commands: JSON.parse('{"__proto__":123}'), hostTurns: 0, groups: [], receipt: {}, logs: [], workspace: '/owned/work/job', projectRoot: '/owned/work/job',
    ...JSON.parse('{"__proto__":{"polluted":true},"externalChecks":{"opaque":"data"}}') };
  const parsed = JobSchema.parse(input);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.hasOwn(parsed, '__proto__'), false);
  assert.deepEqual(parsed.commands, {});
  assert.deepEqual(parsed.externalChecks, { opaque: 'data' });
  const policyEvidence = { url: 'https://example.com/\0', fetchedAt: 'recorded', sha256: 'recorded' };
  assert.equal(JobSchema.parse({ ...input, policyEvidence }).policyEvidence.url, 'https://example.com/\0');
  assert.equal(JobSchema.safeParse({ ...input, spec: { ...spec(), project: { directory: '../outside' } } }).success, false);
  assert.equal(SpecSchema.safeParse({ ...spec(), purpose: '\0' }).success, false);
  for (const createdAt of [Infinity, -Infinity, NaN]) {
    assert.equal(JobSchema.safeParse({ ...input, createdAt }).success, false);
  }
});

test('design reference cleanup matches the URL authority observed by the parser', () => {
  const input = { ...spec(), designRef: ' \ufeffhttps://exa\nmple.com/a\tb\r ' };
  assert.equal(SpecSchema.parse(input).designRef, 'https://example.com/ab');
  assert.equal(input.designRef, ' \ufeffhttps://exa\nmple.com/a\tb\r ');
  assert.equal(SpecSchema.parse({ ...spec(), designRef: ' HTTPS://ExAmPlE.com/path ' }).designRef, 'HTTPS://ExAmPlE.com/path');
  assert.equal(SpecSchema.safeParse({ ...spec(), designRef: 'https://example.com/\0' }).success, false);
});
