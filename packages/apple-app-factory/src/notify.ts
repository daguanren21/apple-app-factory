import { connect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { toError, type Config, type Job } from './schemas.js';
import type { Store } from './store.js';

type Connection = Socket | TLSSocket;

interface SmtpResult { code: number; lines: string[] }

function replyFrom(lines: string[]): SmtpResult {
  const status = Number(lines.at(-1)?.slice(0, 3));
  if (!Number.isInteger(status)) throw new Error(`SMTP server sent an unreadable reply: ${JSON.stringify(lines)}`);
  return { code: status, lines };
}

function readReply(connection: Connection, buffer: string): Promise<{ result: SmtpResult; rest: string }> {
  return new Promise((resolve, reject) => {
    let current = buffer;
    const complete: string[] = [];
    const onData = (chunk: Buffer): void => {
      current += chunk.toString('utf8');
      const lines = current.split('\r\n');
      current = lines.pop() ?? '';
      while (lines.length) {
        const line = lines.shift()!;
        complete.push(line);
        if (line.length < 4 || line[3] !== '-') {
          cleanup();
          try { resolve({ result: replyFrom(complete), rest: current }); } catch (cause) { reject(cause); }
          return;
        }
      }
    };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onClose = (): void => { cleanup(); reject(new Error('SMTP connection closed while reading a reply')); };
    const cleanup = (): void => {
      connection.removeListener('data', onData);
      connection.removeListener('error', onError);
      connection.removeListener('close', onClose);
    };
    connection.on('data', onData);
    connection.on('error', onError);
    connection.on('close', onClose);
  });
}

function expect(result: SmtpResult, allowed: number[], context: string): void {
  if (!allowed.includes(result.code)) throw new Error(`SMTP ${context} failed (${result.code}): ${result.lines.join(' ')}`);
}

async function command(connection: Connection, text: string | null, allowed: number[], context: string, buffer: string): Promise<{ rest: string; result: SmtpResult }> {
  if (text !== null) connection.write(`${text}\r\n`);
  const { result, rest } = await readReply(connection, buffer);
  expect(result, allowed, context);
  return { rest, result };
}

interface SmtpOptions {
  host: string; port: number; secure: boolean; user?: string; password?: string; timeoutMs: number;
}

async function connectSocket(options: SmtpOptions): Promise<Connection> {
  if (options.secure) {
    const socket = tlsConnect({ host: options.host, port: options.port, servername: options.host, rejectUnauthorized: true });
    socket.setTimeout(options.timeoutMs, () => socket.destroy(new Error(`SMTP TLS handshake timed out after ${options.timeoutMs}ms`)));
    return await new Promise<Connection>((resolve, reject) => {
      socket.once('secureConnect', () => resolve(socket));
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('SMTP TLS connection closed before the handshake completed')));
    });
  }
  const socket = connect({ host: options.host, port: options.port });
  socket.setTimeout(options.timeoutMs, () => socket.destroy(new Error(`SMTP connection timed out after ${options.timeoutMs}ms`)));
  return await new Promise<Connection>((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function upgradeTls(socket: Connection, options: SmtpOptions): Promise<TLSSocket> {
  const upgraded = tlsConnect({ socket, servername: options.host, rejectUnauthorized: true });
  await new Promise<void>((resolve, reject) => {
    upgraded.once('secureConnect', () => resolve());
    upgraded.once('error', reject);
  });
  return upgraded;
}

/** Minimal SMTP client: EHLO, optional STARTTLS, AUTH PLAIN, MAIL/RCPT/DATA, QUIT. */
export async function sendMail(options: SmtpOptions, envelope: { from: string; to: string; subject: string; body: string }): Promise<{ messageId: string | null }> {
  let connection = await connectSocket(options);
  try {
    let buffer = '';
    const greeting = await readReply(connection, buffer);
    buffer = greeting.rest;
    expect(greeting.result, [220], 'greeting');
    let ehlo = await command(connection, 'EHLO apphx', [250], 'EHLO', buffer);
    buffer = ehlo.rest;
    const capabilities = ehlo.result.lines.join(' ').toUpperCase();
    if (!options.secure && capabilities.includes('STARTTLS')) {
      buffer = (await command(connection, 'STARTTLS', [220], 'STARTTLS', buffer)).rest;
      connection = await upgradeTls(connection, options);
      ehlo = await command(connection, 'EHLO apphx', [250], 'EHLO', buffer);
      buffer = ehlo.rest;
    }
    if (options.user) {
      if (options.password === undefined) throw new Error('SMTP user is configured without a resolvable password; set the configured passwordEnv in the host environment');
      const payload = Buffer.from(`\0${options.user}\0${options.password}`, 'utf8').toString('base64');
      buffer = (await command(connection, 'AUTH PLAIN', [334], 'AUTH challenge', buffer)).rest;
      buffer = (await command(connection, payload, [235], 'AUTH', buffer)).rest;
    }
    buffer = (await command(connection, `MAIL FROM:<${envelope.from}>`, [250], 'MAIL FROM', buffer)).rest;
    buffer = (await command(connection, `RCPT TO:<${envelope.to}>`, [250, 251], 'RCPT TO', buffer)).rest;
    buffer = (await command(connection, 'DATA', [354], 'DATA', buffer)).rest;
    const headers = [
      `From: ${envelope.from}`,
      `To: ${envelope.to}`,
      `Subject: ${envelope.subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      `Message-ID: <${Date.now().toString(36)}-${Buffer.from(envelope.to).toString('hex').slice(0, 12)}@apphx.local>`,
    ].join('\r\n');
    const dotStuffed = `${headers}\r\n\r\n${envelope.body}`.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const accepted = await new Promise<SmtpResult>((resolve, reject) => {
      let current = '';
      const onData = (chunk: Buffer): void => {
        current += chunk.toString('utf8');
        const end = current.indexOf('\r\n');
        if (end === -1) return;
        connection.removeListener('data', onData);
        const line = current.slice(0, end + 2);
        const status = Number(line.slice(0, 3));
        if (!Number.isInteger(status)) { reject(new Error(`SMTP DATA got an unreadable reply: ${JSON.stringify(line)}`)); return; }
        resolve({ code: status, lines: [line.trim()] });
      };
      connection.on('data', onData);
      connection.write(`${dotStuffed}\r\n.\r\n`);
    });
    expect(accepted, [250], 'DATA acceptance');
    const queued = accepted.lines.join(' ').match(/queued as (?:<)?([^ >]+)/i);
    await command(connection, 'QUIT', [221], 'QUIT', buffer).catch(() => {});
    return { messageId: queued?.[1] ?? null };
  } finally {
    connection.destroy();
  }
}

function template(value: string, job: Job): string {
  return value
    .replaceAll('{product}', job.spec.id)
    .replaceAll('{name}', job.spec.name)
    .replaceAll('{version}', job.spec.version)
    .replaceAll('{platform}', job.spec.platform)
    .replaceAll('{channel}', job.spec.channel)
    .replaceAll('{status}', job.status)
    .replaceAll('{artifact}', job.artifact ? `${job.artifact.kind} ${job.artifact.digest}` : 'none');
}

export type NotifyOutcome = { id: string; notifiedTo: string | null; messageId: string | null; error: string | null };

function notifyConfig(config: Config) {
  if (!config.notify) throw Object.assign(new Error('No notify configuration; add notify.email (from, to, smtpHost, smtpPort) to the control configuration before notifying'), { code: 'SETUP_REQUIRED' });
  return config.notify.email;
}

export async function notifyJob(store: Store, config: Config, id: string): Promise<NotifyOutcome> {
  const email = notifyConfig(config);
  // Claim the send first so concurrent notifiers cannot double-send; the claim
  // is released on success (notifiedAt) or failure (notifyError).
  const job = store.transition(id, current => {
    if (current.status !== 'built' || !current.artifact) throw new Error('Email notification requires a built task with a recorded artifact; packaging runs after the verification and review gates, so only gate-passed tasks are notified');
    if (current.notifiedAt) return {};
    if (current.notifySendingAt) throw new Error('Notification already in flight for this task; retry after the current send settles');
    return { notifySendingAt: new Date().toISOString() };
  });
  if (job.notifiedAt) return { id, notifiedTo: job.notifiedTo ?? null, messageId: null, error: null };
  const to = job.spec.authorEmail ?? email.to;
  const password = email.passwordEnv ? process.env[email.passwordEnv] : undefined;
  const subject = template(email.subject ?? '[apphx] {name} v{version} packaged', job);
  const body = template(email.body ?? `The local packaging pipeline finished for {name} {version} ({platform}/{channel}).\n\nArtifact: {artifact}\nStatus: {status}\n\nVerification and independent review gates passed; this email is a local notification. Store upload, submission and review remain manual human work outside this tool.`, job);
  try {
    const { messageId } = await sendMail({ host: email.smtpHost, port: email.smtpPort, secure: email.secure, user: email.user, password, timeoutMs: email.timeoutMs }, { from: email.from, to, subject, body });
    store.update(id, { notifiedAt: new Date().toISOString(), notifiedTo: to, notifySendingAt: null, notifyError: null });
    store.event(id, { notified: true, notifiedTo: to, messageId });
    return { id, notifiedTo: to, messageId, error: null };
  } catch (cause) {
    const error = toError(cause).message;
    store.update(id, { notifyError: error, notifySendingAt: null });
    store.event(id, { notified: false, notifiedTo: to, error });
    throw new Error(`Email notification failed for ${to}: ${error}`);
  }
}

export async function notifyBuiltJobs(store: Store, config: Config): Promise<NotifyOutcome[]> {
  notifyConfig(config);
  const outcomes: NotifyOutcome[] = [];
  for (const job of store.list()) {
    if (job.status !== 'built' || !job.artifact) continue;
    if (job.notifiedAt) { outcomes.push({ id: job.id, notifiedTo: job.notifiedTo ?? null, messageId: null, error: null }); continue; }
    try { outcomes.push(await notifyJob(store, config, job.id)); }
    catch (cause) { outcomes.push({ id: job.id, notifiedTo: job.spec.authorEmail ?? config.notify!.email.to, messageId: null, error: toError(cause).message }); }
  }
  return outcomes;
}
