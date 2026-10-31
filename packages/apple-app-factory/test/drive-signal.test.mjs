import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConfigSchema } from '../dist/schemas.js';
import { Store } from '../dist/store.js';
import { nextTurn, completeTurn, driveQueue } from '../dist/runner.js';
import { inspectProcess, processGroupAlive, signalOwnedProcessGroup } from '../dist/process.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const spec = {
  id: 'drive-interruption', name: 'Drive interruption', purpose: 'Exercise signal-safe queue ownership', audience: 'Harness maintainers',
  framework: 'flutter', platform: 'ios', channel: 'local', version: '1.0.0',
  differentiators: ['Tracked descendants drain before another queue action'], acceptance: ['Interrupted drive does not leave executable children or claim subsequent work'],
};

async function until(action) {
  const deadline = Date.now() + 10000;
  do {
    const result = action();
    if (result) return result;
    await sleep(20);
  } while (Date.now() < deadline);
  assert.fail('The real drive subprocess did not reach its expected state before the bounded deadline');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`drive ${signal} drains a resistant descendant before lock release and does not claim another job`, { skip: !['darwin', 'linux'].includes(process.platform), timeout: 30000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'apphx-drive-signal-'));
    const ready = join(root, 'ready.json');
    const terminated = join(root, 'term-observed');
    const heartbeat = join(root, 'effects');
    const descendant = `const fs=require('node:fs');
      process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(terminated)},'observed'));
      fs.writeFileSync(${JSON.stringify(heartbeat)},'started');
      setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},'.'),50);
      process.send('ready');`;
    const command = `const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});
      child.once('message',()=>{
        require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({parent:process.pid,descendant:child.pid}));
        child.disconnect();
      });
      setInterval(()=>{},1000);`;
    const config = ConfigSchema.parse({
      stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator', allowLocalExecution: true,
      timeoutMs: 15000, retryDelayMs: 1,
      verification: { prerequisites: [], checks: [[process.execPath, '-e', command]], runtime: [[process.execPath, '-e', 'process.exit(0)']] },
    });
    const configPath = join(root, 'factory.json');
    writeFileSync(configPath, JSON.stringify(config));
    const store = new Store(config.stateDir);
    let child, done;
    let ownedGroup;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (ownedGroup) {
        try { signalOwnedProcessGroup(ownedGroup.pid, ownedGroup.identity, 'SIGKILL'); } catch {}
      }
      // Also retire a group committed just before a setup/assertion failure.
      for (const current of store.list()) {
        for (const pid of current.groups) {
          const identity = current.commands[pid]?.identity;
          if (identity) { try { signalOwnedProcessGroup(pid, identity, 'SIGKILL'); } catch {} }
        }
      }
      if (done) await done;
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    const job = store.enqueue({ ...spec, priority: 'P0' }, config);
    const research = await nextTurn(store, job.id);
    completeTurn(store, job.id, research.turn.id, { viable: true, distinctness: 'Real tracked descendant lifecycle fixture', plan: ['Prepare the minimal project and run its configured command'] });
    const build = await nextTurn(store, job.id);
    writeFileSync(join(build.turn.cwd, 'pubspec.yaml'), 'name: drive_signal\ndependencies:\n  flutter: {sdk: flutter}\n');
    writeFileSync(join(build.turn.cwd, 'main.dart'), 'void main() {}\n');
    completeTurn(store, job.id, build.turn.id);
    const sibling = store.enqueue({ ...spec, id: 'drive-unclaimed', priority: 'P1' }, config);
    const siblingBefore = store.get(sibling.id);
    child = spawn(process.execPath, [cli, 'drive', '--max-rounds', '10', '--host-pid', String(process.pid), '--config', configPath, '--build-only'], {
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, APPHX_HOST_PID: String(process.pid) },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    const metadata = await until(() => {
      const current = store.get(job.id);
      const pid = current.groups[0];
      if (pid && current.commands[pid]) return { pid, identity: current.commands[pid].identity };
      return undefined;
    });
    ownedGroup = metadata;
    await until(() => existsSync(ready));
    const running = JSON.parse(readFileSync(ready, 'utf8'));
    assert.equal(inspectProcess(running.parent)?.parentPid, metadata.pid, 'Payload runs inside the durably registered supervisor group');
    assert.equal(store.db.prepare('SELECT pid FROM worker WHERE id=1').get().pid, child.pid);
    assert.equal(processGroupAlive(metadata.pid), true);
    child.kill(signal);
    await until(() => existsSync(terminated));
    assert.equal(processGroupAlive(metadata.pid), true, 'The resistant descendant must still exist during the termination grace period');
    assert.equal(store.db.prepare('SELECT pid FROM worker WHERE id=1').get().pid, child.pid, 'Drive retains the worker lock while its descendant can execute');
    assert.throws(() => store.acquire(), /already owns this queue/);
    const result = await done;
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, 0, stderr || stdout);
    assert.notEqual(JSON.parse(stdout).action, 'host', 'An interrupted drive must not allocate another native token');
    assert.equal(processGroupAlive(metadata.pid), false);
    const interrupted = store.get(job.id);
    assert.equal(interrupted.stage, 'verify');
    assert.equal(interrupted.status, 'waiting');
    assert.match(interrupted.error, /interrupted/i);
    assert.deepEqual(interrupted.groups, []);
    assert.deepEqual(interrupted.commands, {});
    assert.equal(store.db.prepare('SELECT pid FROM worker WHERE id=1').get(), undefined);
    assert.deepEqual(store.get(sibling.id), siblingBefore);
    const effectsAtExit = readFileSync(heartbeat, 'utf8');
    await sleep(150);
    assert.equal(readFileSync(heartbeat, 'utf8'), effectsAtExit, 'No descendant effect may occur after drive has returned');
    store.acquire();
    store.release();
  });
}

test('an already-aborted drive cannot claim native work', async t => {
  const root = mkdtempSync(join(tmpdir(), 'apphx-drive-aborted-'));
  const config = ConfigSchema.parse({ stateDir: join(root, 'state'), workspaceRoot: join(root, 'workspaces'), packageTarget: 'simulator', verification: { checks: [[process.execPath, '--version']], runtime: [[process.execPath, '--version']] } });
  const store = new Store(config.stateDir);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const job = store.enqueue(spec, config);
  const before = store.get(job.id);
  const controller = new AbortController();
  controller.abort();
  const result = await driveQueue(store, config, { signal: controller.signal });
  assert.notEqual(result.action, 'host');
  assert.deepEqual(store.get(job.id), before);
  assert.equal(store.db.prepare('SELECT pid FROM worker WHERE id=1').get(), undefined);
});
