import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import fs, { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';
import { inspectProcess, processIsAlive } from '../dist/process.js';

const posix = { skip: process.platform !== 'linux' && process.platform !== 'darwin', timeout: 15000 };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factory-worker-incarnation-'));
  const stores = [], children = [], pending = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(pending);
    for (const store of stores) { store.release(); store.close(); }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    open() { const store = new Store(join(root, 'state')); stores.push(store); return store; },
    async helper(args = []) {
      const signaled = join(root, `signaled-${children.length}`);
      const source = `process.on('SIGTERM',()=>require('node:fs').writeFileSync(${JSON.stringify(signaled)},'signaled'));process.send('ready');setTimeout(()=>process.exit(0),10000);`;
      const argv = [process.execPath, '-e', source, '--', ...args];
      const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      children.push(child);
      const done = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      pending.push(done);
      await new Promise((resolve, reject) => {
        child.once('message', resolve);
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Owned helper exited before readiness')));
      });
      return { child, done, argv, signaled };
    },
  };
}

test('process inspection uses real birth and parent fields without inventing macOS argv', posix, async t => {
  const f = fixture(t), helper = await f.helper(['an argument with spaces', '', 'line\nbreak', "quoted'argument"]);
  const inspected = inspectProcess(helper.child.pid);
  assert.ok(inspected);
  assert.equal(inspected.parentPid, process.pid);
  assert.equal(inspectProcess(helper.child.pid)?.identity, inspected.identity);
  assert.equal(processIsAlive(helper.child.pid, inspected.identity), true);
  assert.equal(processIsAlive(helper.child.pid, `different-incarnation:${inspected.identity}`), false);
  assert.equal(processIsAlive(helper.child.pid), true, 'Identity mismatch must not terminate the live process');
  if (process.platform === 'linux') assert.deepEqual(inspected.argv, helper.argv);
  else {
    assert.deepEqual(inspected.argv, []);
    assert.equal(typeof inspected.executable, 'string');
    assert.equal(typeof inspected.command, 'string');
    assert.match(inspected.identity, /^darwin:/);
  }
  assert.equal(existsSync(helper.signaled), false);
  helper.child.kill('SIGKILL');
  await helper.done;
  assert.equal(processIsAlive(helper.child.pid, inspected.identity), false);
  assert.equal(inspectProcess(helper.child.pid), undefined);
});

test('invalid process IDs never address a process or process group', t => {
  const kill = t.mock.method(process, 'kill', () => assert.fail('Invalid PID reached kill'));
  for (const pid of [0, 1, -1, -process.pid, 1.5, NaN, Infinity, 2147483648, Number.MAX_SAFE_INTEGER]) {
    assert.equal(processIsAlive(pid), false);
    assert.equal(inspectProcess(pid), undefined);
  }
  assert.equal(kill.mock.callCount(), 0);
});

test('worker acquisition atomically records an incarnation and release only removes its own claim', posix, t => {
  const f = fixture(t), first = f.open(), second = f.open();
  first.acquire();
  const claim = first.db.prepare('SELECT worker.pid, identity, claim FROM worker JOIN worker_identity USING(id)').get();
  assert.equal(claim.pid, process.pid);
  assert.equal(claim.identity, inspectProcess(process.pid)?.identity);
  assert.equal(typeof claim.claim, 'string');
  second.release();
  assert.deepEqual(first.db.prepare('SELECT worker.pid, identity, claim FROM worker JOIN worker_identity USING(id)').get(), claim);
  assert.throws(() => second.acquire(), /already owns this queue/);
  first.release();
  assert.equal(first.db.prepare('SELECT * FROM worker').get(), undefined);
  assert.equal(first.db.prepare('SELECT * FROM worker_identity').get(), undefined);
  second.acquire();
  first.release();
  assert.equal(first.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
  second.release();
});

test('a superseded Store instance cannot release a newer claim in the same process incarnation', posix, t => {
  const f = fixture(t), first = f.open(), second = f.open();
  first.acquire();
  const old = first.db.prepare('SELECT * FROM worker_identity').get();
  // Model a relinquished persisted claim while retaining its stale in-memory handle.
  first.db.prepare('DELETE FROM worker').run();
  second.acquire();
  const current = first.db.prepare('SELECT * FROM worker_identity').get();
  assert.equal(current.identity, old.identity);
  assert.notEqual(current.claim, old.claim);
  first.release();
  assert.deepEqual(first.db.prepare('SELECT * FROM worker_identity').get(), current);
  assert.equal(first.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
});

test('failed incarnation persistence rolls back the worker row with it', posix, t => {
  const f = fixture(t), store = f.open();
  store.db.exec("CREATE TRIGGER reject_claim BEFORE INSERT ON worker_identity BEGIN SELECT RAISE(ABORT, 'identity commit rejected'); END");
  assert.throws(() => store.acquire(), /identity commit rejected/);
  assert.equal(store.db.prepare('SELECT * FROM worker').get(), undefined);
  assert.equal(store.db.prepare('SELECT * FROM worker_identity').get(), undefined);
  store.db.exec('DROP TRIGGER reject_claim');
  store.acquire();
  assert.equal(store.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
});

test('a modeled reused worker PID is reclaimed without signaling the unrelated live incarnation', posix, async t => {
  const f = fixture(t), store = f.open(), helper = await f.helper();
  const current = inspectProcess(helper.child.pid);
  assert.ok(current);
  store.transaction(() => {
    store.db.prepare('INSERT INTO worker VALUES(1,?)').run(helper.child.pid);
    store.db.prepare('INSERT INTO worker_identity VALUES(1,?,?)').run(`previous-incarnation:${current.identity}`, 'crashed-claim');
  });
  // This models the persisted PID-reuse state, not an actual operating-system PID wrap.
  store.acquire();
  assert.equal(store.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
  assert.equal(processIsAlive(helper.child.pid, current.identity), true);
  assert.equal(existsSync(helper.signaled), false);
});

test('live legacy PID-only owners remain fail-closed and two-value worker INSERT stays compatible', posix, async t => {
  const f = fixture(t), store = f.open(), helper = await f.helper();
  assert.deepEqual(store.db.prepare('PRAGMA table_info(worker)').all().map(column => column.name), ['id', 'pid']);
  store.acquire();
  // A legacy writer must invalidate, not accidentally inherit, the previous incarnation metadata.
  store.db.prepare('INSERT OR REPLACE INTO worker VALUES(1,?)').run(helper.child.pid);
  assert.equal(store.db.prepare('SELECT * FROM worker_identity').get(), undefined);
  store.release();
  assert.equal(store.db.prepare('SELECT pid FROM worker').get().pid, helper.child.pid);
  assert.throws(() => store.acquire(), /already owns this queue/);
  assert.equal(existsSync(helper.signaled), false);
  helper.child.kill('SIGKILL');
  await helper.done;
  store.acquire();
  assert.equal(store.db.prepare('SELECT pid FROM worker').get().pid, process.pid);
});

test('unreadable live incarnation and EPERM do not authorize taking or signaling an owner', posix, async t => {
  const f = fixture(t), store = f.open(), helper = await f.helper();
  const birth = inspectProcess(helper.child.pid);
  assert.ok(birth);
  store.transaction(() => {
    store.db.prepare('INSERT INTO worker VALUES(1,?)').run(helper.child.pid);
    store.db.prepare('INSERT INTO worker_identity VALUES(1,?,?)').run(birth.identity, 'live-claim');
  });
  const originalRead = fs.readFileSync, originalSpawn = childProcess.spawnSync, originalKill = process.kill;
  try {
    fs.readFileSync = function(path, ...args) {
      if (String(path).startsWith(`/proc/${helper.child.pid}/`)) throw Object.assign(new Error('Inspection denied'), { code: 'EACCES' });
      return originalRead.call(this, path, ...args);
    };
    childProcess.spawnSync = function(file, argv, ...args) {
      if (file === '/bin/ps' && argv.includes(String(helper.child.pid))) return { error: Object.assign(new Error('Inspection denied'), { code: 'EACCES' }), status: null, stdout: '', stderr: '' };
      return originalSpawn.call(this, file, argv, ...args);
    };
    process.kill = function(pid, signal) {
      if (pid === helper.child.pid) {
        assert.equal(signal, 0, 'Ownership inspection must never signal an arbitrary live PID');
        throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
      }
      return originalKill.call(this, pid, signal);
    };
    syncBuiltinESMExports();
    assert.equal(inspectProcess(helper.child.pid), undefined);
    assert.equal(processIsAlive(helper.child.pid), true);
    assert.equal(processIsAlive(helper.child.pid, `different:${birth.identity}`), true);
    assert.throws(() => store.acquire(), /already owns this queue/);
    assert.equal(store.db.prepare('SELECT pid FROM worker').get().pid, helper.child.pid);
  } finally {
    fs.readFileSync = originalRead;
    childProcess.spawnSync = originalSpawn;
    process.kill = originalKill;
    syncBuiltinESMExports();
  }
  assert.equal(processIsAlive(helper.child.pid, birth.identity), true);
  assert.equal(existsSync(helper.signaled), false);
});
