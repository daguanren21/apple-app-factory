import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

export const MARKER = 'APPHX_POLICY_ORACLE ';
function file(root, name) {
  const path = join(root, name);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error(`Invalid controlled source: ${name}`);
  return readFileSync(path, 'utf8');
}

// VM removes ordinary host APIs from this deliberately small fixture. It is NOT
// an OS sandbox or a security boundary against arbitrary hostile JavaScript.
// The controller also runs this oracle in a time/memory/output-bounded child.
export function runOracle(root, mode = 'runtime') {
  const proof = { format: 'apphx-controlled-runtime-v1', mode, sourceHash: null, passed: false, assertions: [], failures: [], nativeUI: false };
  let scratch;
  try {
    if (!['check', 'runtime'].includes(mode)) throw new Error('Unknown oracle mode');
    const source = file(root, 'app.js');
    const privacyText = file(root, 'privacy.json');
    proof.sourceHash = createHash('sha256').update(source).update('\0').update(privacyText).digest('hex');
    const script = new vm.Script(source, { filename: 'controlled-app.js' });
    const privacy = JSON.parse(privacyText);
    if (typeof privacy.collectsData !== 'boolean' || typeof privacy.telemetry !== 'boolean' || privacy.storage !== 'local-only') throw new Error('Privacy declaration is incomplete');
    proof.assertions.push('source-parses', 'privacy-declaration-parses');
    if (mode === 'check') { proof.passed = true; return proof; }
    const fresh = () => {
      const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
      script.runInContext(context, { timeout: 200 });
      return context;
    };
    const invoke = (context, expression) => {
      const result = vm.runInContext(expression, context, { timeout: 200 });
      if (typeof result !== 'string' || result.length > 65536) throw new Error('Runtime must return bounded serialized evidence');
      return JSON.parse(result);
    };
    const assert = (condition, name) => {
      if (condition) proof.assertions.push(name);
      else proof.failures.push(name);
    };
    const ids = [randomUUID(), randomUUID()];
    const texts = ['Private record ' + randomUUID(), 'Second record: 雨 / ' + randomUUID()];
    const first = fresh();
    const initial = invoke(first, `globalThis.book = new RecordBook(); book.put(${JSON.stringify(ids[0])}, ${JSON.stringify(texts[0])}); book.put(${JSON.stringify(ids[1])}, ${JSON.stringify(texts[1])}); JSON.stringify({ first: book.get(${JSON.stringify(ids[0])}), second: book.get(${JSON.stringify(ids[1])}), snapshot: book.snapshot(), telemetry: book.telemetry })`);
    assert(initial.first === texts[0] && initial.second === texts[1], 'distinct-record-write-read');
    assert(Array.isArray(initial.telemetry) && initial.telemetry.length === 0, 'no-runtime-telemetry');
    assert(privacy.collectsData === false && privacy.telemetry === false, 'local-only-privacy-declaration');
    if (typeof initial.snapshot !== 'string') throw new Error('snapshot() must return serialized records');
    scratch = mkdtempSync(join(tmpdir(), 'apphx-policy-oracle-'));
    const persisted = join(scratch, 'records.json');
    writeFileSync(persisted, initial.snapshot, { mode: 0o600 });
    const second = fresh();
    const reopened = invoke(second, `globalThis.book = new RecordBook(${JSON.stringify(readFileSync(persisted, 'utf8'))}); JSON.stringify({ first: book.get(${JSON.stringify(ids[0])}), second: book.get(${JSON.stringify(ids[1])}) })`);
    assert(reopened.first === texts[0] && reopened.second === texts[1], 'records-survive-fresh-runtime');
    const removed = invoke(second, `book.remove(${JSON.stringify(ids[0])}); JSON.stringify({ snapshot: book.snapshot(), telemetry: book.telemetry })`);
    if (typeof removed.snapshot !== 'string') throw new Error('Deletion snapshot must be serialized');
    writeFileSync(persisted, removed.snapshot);
    const third = fresh();
    const final = invoke(third, `globalThis.book = new RecordBook(${JSON.stringify(readFileSync(persisted, 'utf8'))}); JSON.stringify({ first: book.get(${JSON.stringify(ids[0])}), second: book.get(${JSON.stringify(ids[1])}) })`);
    assert(final.first === null && final.second === texts[1], 'deletion-survives-fresh-runtime');
    assert(Array.isArray(removed.telemetry) && removed.telemetry.length === 0, 'no-delete-telemetry');
    proof.passed = proof.failures.length === 0;
  } catch (error) {
    proof.failures.push(String(error.message).slice(0, 1000));
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
  return proof;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const proof = runOracle(process.cwd(), process.argv[2]);
  console.log(MARKER + JSON.stringify(proof));
  process.exitCode = proof.passed ? 0 : 1;
}
