import { appendFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalRoot, cli, json, ownedPath, readState, sha256, text } from './control.mjs';

// A transparent real apphx CLI adapter, not an actor/model launcher. Receipts
// record subprocess results, not grades. Direct CLI work is visible in SQLite,
// but rejected complete calls require this adapter because apphx rolls them back.
export function runHost(caseDirectory, command, args = []) {
  const root = canonicalRoot(caseDirectory);
  const descriptor = json(ownedPath(root, 'control/host.json'));
  if (!['next', 'complete', 'step', 'status', 'events', 'abandon'].includes(command)) throw new Error('Allowed actions: next, complete, step, status, events, abandon');
  const expected = command === 'complete' ? [1, 2] : command === 'abandon' ? [1] : [0];
  if (!expected.includes(args.length)) throw new Error('complete requires TURN_ID [result.json]; abandon requires TURN_ID; other actions take no extra arguments');
  let payload = null;
  const forwarded = [...args];
  if (command === 'complete' && args[1]) {
    const resultPath = ownedPath(root, resolve(root, args[1]));
    payload = JSON.parse(text(resultPath, 1024 * 1024));
    forwarded[1] = resultPath;
  }
  const lock = ownedPath(root, 'control/host.lock');
  const fd = openSync(lock, 'wx', 0o600);
  try {
    const before = readState(root, descriptor.jobId);
    if (command === 'step' && before.job.stage !== 'verify') throw new Error('This bounded evaluation permits only verification steps, never packaging or publication');
    const startedAt = Date.now();
    const result = cli([command, descriptor.jobId, ...forwarded], ownedPath(root, 'control/factory.json'));
    const after = readState(root, descriptor.jobId);
    const receipt = {
      format: 'apphx-native-cli-receipt-v1', startedAt, finishedAt: Date.now(), command, args: forwarded, payload,
      jobId: descriptor.jobId, beforeHash: sha256(JSON.stringify(before)), afterHash: sha256(JSON.stringify(after)),
      beforeTurn: before.job.turn, afterTurn: after.job.turn, beforeStage: before.job.stage, afterStage: after.job.stage,
      ...result,
    };
    appendFileSync(ownedPath(root, 'control/trace.jsonl'), JSON.stringify(receipt) + '\n', { mode: 0o600 });
    return result;
  } finally { closeSync(fd); unlinkSync(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [, , root, command, ...args] = process.argv;
    if (!root || !command) throw new Error('Usage: node evals/host.mjs CASE_DIRECTORY next|complete|step|status|events|abandon [TURN_ID [result.json]]');
    const result = runHost(root, command, args);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.error) console.error(JSON.stringify({ error: result.error }));
    process.exitCode = result.status ?? 1;
  } catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
