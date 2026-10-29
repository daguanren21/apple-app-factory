import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { notifyJob, notifyBuiltJobs } from '../dist/notify.js';

const success = [process.execPath, '-e', 'process.exit(0)'];
const digest = 'a'.repeat(64);

function fakeSmtp(t) {
  const messages = [];
  const server = createServer(socket => {
    let buffer = '';
    let authPayload = false;
    let dataMode = false;
    let data = '';
    socket.write('220 localhost ESMTP apphx-test\r\n');
    const respond = (line) => {
      if (dataMode) {
        if (line === '.') { dataMode = false; messages.push(data); data = ''; socket.write('250 2.0.0 Ok: queued as <test-message>\r\n'); }
        else data += line.replace(/^\.\./, '.') + '\n';
        return;
      }
      const upper = line.toUpperCase();
      if (authPayload) { authPayload = false; socket.write('235 2.7.0 Authentication successful\r\n'); return; }
      if (upper.startsWith('EHLO')) socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (upper.startsWith('AUTH PLAIN')) { socket.write('334 \r\n'); authPayload = true; }
      else if (upper.startsWith('MAIL FROM')) socket.write('250 OK\r\n');
      else if (upper.startsWith('RCPT TO')) socket.write('250 OK\r\n');
      else if (upper === 'DATA') { dataMode = true; socket.write('354 Send data\r\n'); }
      else if (upper.startsWith('QUIT')) socket.write('221 Bye\r\n');
      else socket.write('250 OK\r\n');
    };
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) respond(line);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    t.after(() => server.close());
    resolve({ server, messages, port: server.address().port });
  }));
}

function fixture(t, notifyEmail) {
  const root = mkdtempSync(join(tmpdir(), 'factory-notify-'));
  const config = ConfigSchema.parse({
    stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator',
    allowLocalExecution: true,
    verification: { prerequisites: [], checks: [success], runtime: [success] },
    notify: { email: notifyEmail },
  });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const built = (name, specExtra = {}, patch = {}) => {
    const job = store.enqueue({
      id: `notify-${name}`, name: `Notify ${name}`, framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0',
      purpose: `Send ${name} mail`, audience: 'Factory maintainers',
      differentiators: ['Gate-passed notification'], acceptance: ['Preserve notification proof'],
      ...specExtra,
    }, config);
    return store.update(job.id, {
      status: 'built',
      artifact: { kind: 'ios-simulator', path: join(root, 'App.app'), digest, createdAt: new Date().toISOString() },
      ...patch,
    });
  };
  return { root, config, store, built };
}

test('notifyJob emails the author once for a built task and persists the receipt', async t => {
  const { messages, port } = await fakeSmtp(t);
  const f = fixture(t, { from: 'factory@example.org', to: 'author@example.org', smtpHost: '127.0.0.1', smtpPort: port, secure: false, user: 'bot', passwordEnv: 'SMTP_PASS' });
  process.env.SMTP_PASS = 'secret';
  t.after(() => { delete process.env.SMTP_PASS; });
  const job = f.built('one');
  const outcome = await notifyJob(f.store, f.config, job.id);
  assert.equal(outcome.error, null);
  assert.equal(outcome.notifiedTo, 'author@example.org');
  assert.equal(outcome.messageId, 'test-message');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Subject: \[apphx\] Notify one v1\.0\.0 packaged/);
  assert.match(messages[0], /ios-simulator/);
  assert.equal(messages[0].includes('secret'), false);
  const stored = f.store.get(job.id);
  assert.match(stored.notifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(stored.notifiedTo, 'author@example.org');
  const events = f.store.events(job.id).map(event => event.data);
  assert.ok(events.some(data => data.notified === true && data.messageId === 'test-message'));
  const again = await notifyJob(f.store, f.config, job.id);
  assert.equal(again.error, null);
  assert.equal(messages.length, 1);
  assert.equal(f.store.get(job.id).notifiedAt, stored.notifiedAt);
});

test('spec authorEmail overrides the configured recipient', async t => {
  const { messages, port } = await fakeSmtp(t);
  const f = fixture(t, { from: 'factory@example.org', to: 'default@example.org', smtpHost: '127.0.0.1', smtpPort: port, secure: false });
  const job = f.built('two', { authorEmail: 'author-two@example.org' });
  const outcome = await notifyJob(f.store, f.config, job.id);
  assert.equal(outcome.error, null);
  assert.equal(outcome.notifiedTo, 'author-two@example.org');
  assert.match(messages[0], /To: author-two@example\.org/);
});

test('notifyJob refuses a task that has not passed the gates', async t => {
  const { port } = await fakeSmtp(t);
  const f = fixture(t, { from: 'factory@example.org', to: 'a@example.org', smtpHost: '127.0.0.1', smtpPort: port, secure: false });
  const job = f.built('three');
  f.store.update(job.id, { status: 'blocked' });
  await assert.rejects(notifyJob(f.store, f.config, job.id), /built task/);
});

test('notifyBuiltJobs sweeps unnotified built tasks and skips notified ones', async t => {
  const { messages, port } = await fakeSmtp(t);
  const f = fixture(t, { from: 'factory@example.org', to: 'a@example.org', smtpHost: '127.0.0.1', smtpPort: port, secure: false });
  const fresh = f.built('fresh');
  const done = f.built('done', {}, { notifiedAt: new Date().toISOString(), notifiedTo: 'a@example.org' });
  const queued = f.built('queued');
  f.store.update(queued.id, { status: 'queued', artifact: null });
  const outcomes = await notifyBuiltJobs(f.store, f.config);
  assert.deepEqual(outcomes.map(outcome => [outcome.id, outcome.error]), [[fresh.id, null], [done.id, null]]);
  assert.equal(messages.length, 1);
  assert.match(f.store.get(fresh.id).notifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(f.store.get(queued.id).notifiedAt ?? null, null);
});

test('send failure is recorded as notifyError and stays retryable', async t => {
  const closed = await new Promise(resolve => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const f = fixture(t, { from: 'f@example.org', to: 'a@example.org', smtpHost: '127.0.0.1', smtpPort: closed, secure: false, timeoutMs: 3000 });
  const job = f.built('fail');
  await assert.rejects(notifyJob(f.store, f.config, job.id), /notification failed/i);
  const stored = f.store.get(job.id);
  assert.match(stored.notifyError, /ECONNREFUSED|connect|closed/i);
  assert.equal(stored.notifiedAt ?? null, null);
  assert.equal(stored.notifySendingAt ?? null, null);
  const events = f.store.events(job.id).map(event => event.data);
  assert.ok(events.some(data => data.notified === false));
});

test('a claimed in-flight notification cannot double-send', async t => {
  const { messages, port } = await fakeSmtp(t);
  const f = fixture(t, { from: 'f@example.org', to: 'a@example.org', smtpHost: '127.0.0.1', smtpPort: port, secure: false });
  const job = f.built('inflight');
  f.store.update(job.id, { notifySendingAt: new Date().toISOString() });
  await assert.rejects(notifyJob(f.store, f.config, job.id), /in flight/);
  assert.equal(messages.length, 0);
});

test('notify without configuration fails fast with a setup error', async t => {
  const { port } = await fakeSmtp(t);
  const f = fixture(t, { from: 'f@example.org', to: 'a@example.org', smtpHost: '127.0.0.1', smtpPort: port, secure: false });
  const config = ConfigSchema.parse({ ...f.config, notify: undefined });
  const job = f.built('noconfig');
  await assert.rejects(notifyJob(f.store, config, job.id), /No notify configuration/);
});

test('notify.email configuration is validated strictly', async t => {
  const { port } = await fakeSmtp(t);
  const base = fixture(t, { from: 'f@example.org', to: 'a@example.org', smtpHost: '127.0.0.1', smtpPort: port, secure: false });
  assert.throws(() => ConfigSchema.parse({ ...base.config, notify: { email: { from: 'f@example.org', to: 'a@example.org', smtpHost: '127.0.0.1', smtpPort: port, smtpPassword: 'leak' } } }), /unrecognized_keys|Invalid input/i);
  assert.throws(() => ConfigSchema.parse({ ...base.config, notify: { email: { from: 'not-an-email', to: 'a@example.org', smtpHost: '127.0.0.1' } } }), /Invalid email|email/i);
});
