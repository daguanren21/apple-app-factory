import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { validateAppleSpec } from './apple.js';
import { toError, type Config, type InboxEntry } from './schemas.js';
import { MAX_INPUT_BYTES, parseRequirement, readInputFile, type Requirement } from './requirements.js';
import type { Store } from './store.js';

export type InboxScan = { entries: InboxEntry[]; error: string | null; observed: boolean };


function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function requestValue({ spec, baseJobId }: Requirement): unknown {
  return { ...spec, ...(baseJobId === undefined ? {} : { baseJobId }) };
}


export function submitRequirement(config: Config, value: unknown): { path: string } {
  if (!config.inbox) throw new Error('No inbox is configured; set inbox.directory before submitting a requirement');
  const request = parseRequirement(value);
  if (config.allowSubmit) validateAppleSpec(request.spec);
  const serialized = canonical(requestValue(request));
  const content = `${serialized}\n`;
  if (Buffer.byteLength(content) > MAX_INPUT_BYTES) throw new Error(`Requirement exceeds ${MAX_INPUT_BYTES} bytes; reduce its size`);
  const directory = resolve(config.inbox.directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const version = request.spec.apple?.version ?? '1.0.0';
  const versionKey = createHash('sha256').update(version).digest('hex');
  const path = join(directory, `${request.spec.id}-${versionKey}.json`);
  const temporary = join(directory, `.requirement-${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      // A hard link publishes complete bytes atomically without replacing another writer's request.
      linkSync(temporary, path);
    } catch (error) {
      if (toError(error).code !== 'EEXIST') throw error;
      const existing = parseRequirement(JSON.parse(readInputFile(path).toString('utf8')) as unknown);
      if (canonical(requestValue(existing)) !== serialized) {
        throw new Error(`Requirement ${request.spec.id} ${version} already exists at ${path} with different content; use a new product version`);
      }
    }
    return { path };
  } finally {
    unlinkSync(temporary);
  }
}

export async function scanInbox(store: Store, config: Config, options: { observe?: boolean; signal?: AbortSignal } = {}): Promise<InboxScan> {
  const observed = options.observe === true;
  if (!config.inbox) return { entries: [], error: null, observed };
  const directory = resolve(config.inbox.directory);
  let names: string[];
  try {
    names = readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    return { entries: [], error: `Cannot read inbox ${directory}: ${toError(error).message}`, observed };
  }
  const previous = new Map(store.inboxEntries().map(entry => [entry.source, entry]));
  const entries: InboxEntry[] = [];
  const pending: Requirement[] = [];
  for (const name of names) {
    await yieldTurn();
    if (options.signal?.aborted) break;
    const source = join(directory, name);
    let digest: string | null = null;
    try {
      const bytes = readInputFile(source);
      digest = createHash('sha256').update(bytes).digest('hex');
      const request = parseRequirement(JSON.parse(bytes.toString('utf8')) as unknown);
      if (config.allowSubmit) validateAppleSpec(request.spec);
      const old = previous.get(source);
      if (!observed && old?.status === 'accepted' && old.digest === digest && old.jobId && store.get(old.jobId).requestSpec !== null) {
        store.checkIngest(request.spec, request.baseJobId);
        entries.push(old);
      } else if (observed) {
        const existing = store.checkIngest(request.spec, request.baseJobId, pending);
        entries.push({ source, digest, status: 'accepted', jobId: existing?.id ?? null, error: null, observedAt: Date.now() });
        pending.push(request);
      } else {
        entries.push(store.ingest(source, digest, request.spec, config, request.baseJobId));
      }
    } catch (error) {
      const message = `Cannot accept requirement ${source}: ${toError(error).message}`;
      const old = previous.get(source);
      if (observed) {
        entries.push({ source, digest, status: 'error', jobId: null, error: message, observedAt: Date.now() });
      } else if (old?.status === 'error' && old.digest === digest && old.error === message) {
        entries.push(old);
      } else {
        entries.push(store.inboxError(source, digest, message));
      }
    }
  }
  return { entries, error: null, observed };
}
