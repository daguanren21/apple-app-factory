import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const session = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.match(session.avd, /^apphx-smoke-[a-f0-9]+$/);
assert.match(session.serial, /^emulator-\d+$/);
assert.ok(session.port > 1024 && session.port !== 5037);
function adb(args, binary = false) {
  const result = spawnSync(join(session.sdk, 'platform-tools/adb'), ['-P', String(session.port), '-s', session.serial, ...args], { encoding: binary ? undefined : 'utf8', timeout: 45000 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}
assert.equal(adb(['emu', 'avd', 'name']).split(/\r?\n/)[0], session.avd, 'Refusing non-owned emulator');
const app = 'dev.apphx.runtime';
const token = 'record-' + session.avd.slice(-12);
mkdirSync('build/screenshots', { recursive: true });
const pause = () => new Promise(resolve => setTimeout(resolve, 500));
async function tree() {
  adb(['shell', 'uiautomator', 'dump', '/sdcard/apphx-window.xml']);
  const xml = adb(['shell', 'cat', '/sdcard/apphx-window.xml']);
  writeFileSync('build/screenshots/latest.xml', xml);
  return xml;
}
function tap(xml, label) {
  const node = [...xml.matchAll(/<node\b[^>]*>/g)].map(match => match[0]).find(node => node.includes(`text="${label}"`) || node.includes(`content-desc="${label}"`));
  assert.ok(node, `UI control missing: ${label}`);
  const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  assert.ok(bounds);
  adb(['shell', 'input', 'tap', String(Math.floor((+bounds[1] + +bounds[3]) / 2)), String(Math.floor((+bounds[2] + +bounds[4]) / 2))]);
}
function screenshot(name) {
  const png = adb(['exec-out', 'screencap', '-p'], true);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.length > 1000);
  writeFileSync(`build/screenshots/${name}.png`, png);
}
try {
  adb(['install', '-r', 'build/records.apk']);
  adb(['shell', 'pm', 'clear', app]);
  adb(['shell', 'am', 'start', '-W', '-n', `${app}/.MainActivity`]);
  await pause();
  let xml = await tree();
  assert.ok(xml.includes('No saved record'));
  tap(xml, 'Record text');
  await new Promise(resolve => setTimeout(resolve, 1500));
  for (const character of token) {
    adb(['shell', 'input', 'text', character]);
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  assert.ok((await tree()).includes(`text="${token}"`), 'Native text input did not receive the complete record');
  tap(await tree(), 'Save record');
  await pause();
  xml = await tree();
  assert.ok(xml.includes(`text="${token}"`), 'Save did not reach visible UI');
  writeFileSync('build/screenshots/saved.xml', xml); screenshot('saved');
  adb(['shell', 'am', 'force-stop', app]);
  adb(['shell', 'am', 'start', '-W', '-n', `${app}/.MainActivity`]);
  await pause();
  xml = await tree();
  assert.ok(xml.includes(`text="${token}"`), 'Relaunch lost persisted record');
  const preferences = adb(['shell', 'run-as', app, 'cat', 'shared_prefs/records.xml']);
  assert.ok(preferences.includes(token));
  writeFileSync('build/screenshots/relaunch.xml', xml); screenshot('relaunch');
  writeFileSync('build/runtime-evidence.json', JSON.stringify({ token, avd: session.avd, serial: session.serial, adbPort: session.port, saved: true, relaunched: true, preferences }, null, 2));
  console.log('APPHX_REAL_ANDROID ' + JSON.stringify({ token, visibleSave: true, persistedRelaunch: true }));
} finally {
  adb(['shell', 'am', 'force-stop', app]);
}
