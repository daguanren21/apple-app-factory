import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerCommand, probeProvider } from '../dist/agents.js';

const request = { prompt: 'Inspect the project.', cwd: process.cwd() };

test('rejects a Cursor review rather than substituting a prompt-based read-only claim', () => {
  assert.throws(
    () => providerCommand({ kind: 'cursor' }, { ...request, readOnly: true }),
    /Cursor read-only execution is unsupported.*filesystem read-only sandbox/,
  );
});

test('rejects unsupported model routing instead of silently using a different model', async () => {
  for (const property of ['model', 'provider']) {
    const provider = { kind: 'deepseek', [property]: 'configured-route' };
    assert.throws(() => providerCommand(provider, request));
    await assert.rejects(probeProvider(provider));
  }
  assert.throws(() => providerCommand({ kind: 'cursor', provider: 'xai' }, request));
  assert.throws(() => providerCommand({ kind: 'pi', provider: 'xai' }, request));
});

test('rejects malformed process inputs before spawning an agent', () => {
  for (const provider of [null, [], { kind: 'grok' }, { kind: 'codex', executable: '' }, { kind: 'codex', model: '--help' }, { kind: 'pi', model: 'bad\0model' }]) {
    assert.throws(() => providerCommand(provider, request));
  }
  for (const options of [{ ...request, prompt: '' }, { ...request, prompt: null }, { ...request, cwd: undefined }, { ...request, cwd: '\0' }, { ...request, readOnly: 'true' }]) {
    assert.throws(() => providerCommand({ kind: 'codex' }, options));
  }
});

test('reports a missing executable separately from an authentication failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'factory-agent-'));
  try {
    const result = await probeProvider({ kind: 'codex', executable: join(directory, 'missing-agent') });
    assert.equal(result.available, false);
    assert.match(result.detail, /executable not found/);
    assert.doesNotMatch(result.detail, /authentication fail|not authenticated|log in/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('does not misidentify an executable with successful help as a compatible coding CLI', async () => {
  const result = await probeProvider({ kind: 'cursor', executable: process.execPath });
  assert.equal(result.available, false);
  assert.match(result.detail, /was reached.*does not advertise required capabilities/);
  assert.match(result.detail, /Authentication was not checked/);
});

test('distinguishes a reached but failing executable from a missing executable', async () => {
  const result = await probeProvider({ kind: 'codex', executable: process.execPath });
  assert.equal(result.available, false);
  assert.match(result.detail, /was reached, but its help probe exited/);
  assert.doesNotMatch(result.detail, /executable not found/);
  assert.match(result.detail, /Authentication was not checked/);
});

test('provider capability subprocesses exclude publisher and unlisted variables', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-probe-environment-'));
  const record = join(root, 'environment.json');
  const executable = join(root, 'provider');
  const forbidden = ['ASC_SYNTHETIC', 'APPLE_SYNTHETIC', 'FASTLANE_SYNTHETIC', 'MATCH_SYNTHETIC', 'UNLISTED_SYNTHETIC'];
  const keys = [...forbidden, 'FACTORY_ALLOWED'];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(async () => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  for (const key of keys) process.env[key] = 'synthetic-only';
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({forbidden:${JSON.stringify(forbidden)}.filter(key=>Object.hasOwn(process.env,key)),allowed:process.env.FACTORY_ALLOWED,hasPath:Boolean(process.env.PATH)}));console.log('--sandbox read-only workspace-write --cd --skip-git-repo-check --output-last-message');\n`, { mode: 0o700 });
  const result = await probeProvider({ kind: 'codex', executable }, { agentEnv: ['FACTORY_ALLOWED'] });
  assert.equal(result.available, true, result.detail);
  const received = JSON.parse(await readFile(record, 'utf8'));
  assert.deepEqual(received.forbidden, []);
  assert.equal(received.allowed, 'synthetic-only');
  assert.equal(received.hasPath, true);
});
