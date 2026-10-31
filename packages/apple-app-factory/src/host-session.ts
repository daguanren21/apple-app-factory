import { basename, isAbsolute, resolve } from 'node:path';
import { inspectProcess, processIsAlive, type ProcessInfo } from './process.js';

type Manager = 'pnpm' | 'npm' | 'npx' | 'yarn';
const guidance = 'Pass --host-pid <persistent-controller-pid> or APPHX_HOST_PID from a live ancestor that will remain alive until its native workers finish.';
const shells: Record<string, true | undefined> = { sh: true, bash: true, dash: true, zsh: true, ksh: true };
const interactiveFlags = ['-i', '-l', '-il', '-li', '--login', '--noprofile', '--norc'];
const unsupportedLaunchers: Record<string, true | undefined> = { env: true, timeout: true, time: true, setsid: true, nohup: true, sudo: true, doas: true };
const executionPrefixes: Record<Manager, string[][]> = {
  pnpm: [['exec', '--'], ['exec']],
  npm: [['exec', '--offline', '--package=apphx', '--'], ['exec', '--offline', '--'], ['exec', '--'], ['exec']],
  npx: [['--offline'], ['--no-install'], []],
  yarn: [['exec', '--'], ['exec']],
};

function managerName(path: string): Manager | undefined {
  const name = basename(path);
  switch (name) {
    case 'pnpm': case 'pnpm-native': case 'pnpm.cjs': case 'pnpm.mjs': case 'pnpm.js': return 'pnpm';
    case 'npm': case 'npm-cli.js': case 'npm.mjs': return 'npm';
    case 'npx': case 'npx-cli.js': case 'npx.mjs': return 'npx';
    case 'yarn': case 'yarnpkg': case 'yarn.js': case 'yarn.cjs': case 'yarn.mjs': return 'yarn';
  }
  if (/^yarn-\d[\w.-]*\.cjs$/.test(name)) return 'yarn';
  return undefined;
}

function corepackEntrypoint(path: string): boolean {
  return /^corepack(?:\.[cm]?js)?$/.test(basename(path));
}

function executesThisCLI(manager: Manager, args: string[]): boolean {
  for (const prefix of executionPrefixes[manager]) {
    if (!prefix.every((value, index) => args[index] === value)) continue;
    const command = args[prefix.length];
    if (!command) continue;
    if (basename(command) === 'apphx') return true;
    const script = args[prefix.length + 1];
    const name = basename(command);
    if ((name === 'node' || name === 'nodejs') && script && process.argv[1] && resolve(script) === resolve(process.argv[1])) return true;
  }
  return false;
}

function rawExecution(manager: Manager, command: string): boolean {
  // ps output is not argv. Match only literal known launch forms; never split it.
  const targets = ['apphx'];
  if (process.argv[1]) targets.push(`${process.execPath} ${process.argv[1]}`, `node ${process.argv[1]}`, `nodejs ${process.argv[1]}`);
  for (const prefix of executionPrefixes[manager]) {
    const start = prefix.length ? `${prefix.join(' ')} ` : '';
    for (const target of targets) {
      const expected = `${start}${target}`;
      if (command === expected || command.startsWith(`${expected} `)) return true;
    }
  }
  return false;
}

function processKind(info: ProcessInfo): 'host' | 'wrapper' | 'shell' | 'unknown' {
  const executable = info.argv[0] ?? info.executable;
  if (!executable) return 'unknown';
  const name = basename(executable).replace(/^-/, '');
  if (unsupportedLaunchers[name] === true) return 'unknown';
  if (corepackEntrypoint(executable)) return 'unknown';
  if (shells[name] === true) {
    if (info.argv.length) {
      if (info.argv.slice(1).every(value => interactiveFlags.includes(value))) return 'host';
      return info.argv.length === 3 && /^-[a-z]*c[a-z]*$/.test(info.argv[1]!) ? 'shell' : 'unknown';
    }
    const command = info.command;
    if (!command) return 'unknown';
    for (const invocation of [executable, name, `-${name}`]) {
      if (command === invocation || interactiveFlags.some(flag => command === `${invocation} ${flag}`)) return 'host';
      if (['-c', '-lc', '-ec'].some(flag => command.startsWith(`${invocation} ${flag} `))) return 'shell';
    }
    return 'unknown';
  }
  const node = name === 'node' || name === 'nodejs';
  if (info.argv.length) {
    if (node && corepackEntrypoint(info.argv[1] ?? '')) return 'unknown';
    const manager = managerName(node ? info.argv[1] ?? '' : executable);
    if (manager) return executesThisCLI(manager, info.argv.slice(node ? 2 : 1)) ? 'wrapper' : 'unknown';
    // Node options and overwritten npm process titles are not proof of a wrapper.
    if (node && info.argv[1]?.startsWith('-') && info.argv.slice(2).some(value => managerName(value) || corepackEntrypoint(value))) return 'unknown';
    if (/^(?:pnpm|npm|npx|yarn|corepack)(?: |$)/.test(name)) return 'unknown';
    return 'host';
  }
  const command = info.command;
  if (!command) return 'unknown';
  const manager = managerName(executable);
  if (manager) {
    for (const invocation of [executable, name]) {
      if (command.startsWith(`${invocation} `) && rawExecution(manager, command.slice(invocation.length + 1))) return 'wrapper';
    }
    return 'unknown';
  }
  if (/^(?:pnpm|npm|npx|yarn|corepack)(?: |$)/.test(name)) return 'unknown';
  if (node) {
    const launcher = process.env.npm_execpath;
    const manager = launcher && isAbsolute(launcher) ? managerName(launcher) : undefined;
    if (manager && launcher) {
      for (const invocation of [executable, name]) {
        const prefix = `${invocation} ${launcher} `;
        if (command.startsWith(prefix)) return rawExecution(manager, command.slice(prefix.length)) ? 'wrapper' : 'unknown';
      }
    }
    // Only the executable/script position can identify a launcher. A stable Node
    // host may mention pnpm in a test name or other argument without being pnpm.
    const invocation = [executable, name].find(value => command.startsWith(`${value} `));
    const remainder = invocation ? command.slice(invocation.length + 1) : command;
    if (/^(?:[^\r\n]*\/)?(?:pnpm(?:-native|\.[cm]?js)?|npm(?:-cli\.js|\.mjs)?|npx(?:-cli\.js|\.mjs)?|yarn(?:pkg|(?:-\d[\w.-]*)?\.[cm]?js)?|corepack(?:\.[cm]?js)?)(?: |$)/.test(remainder)) return 'unknown';
  }
  return 'host';
}

/** Resolve native work ownership without assigning it to a one-shot package manager. */
export function resolveHostOwner(explicit?: string): { ownerPid: number; ownerIdentity?: string } {
  const requested = explicit ?? process.env.APPHX_HOST_PID;
  let target: number | undefined;
  if (requested !== undefined) {
    target = Number(requested);
    if (!/^[1-9]\d*$/.test(requested) || !Number.isSafeInteger(target) || target > 2_147_483_647) throw new Error(`--host-pid / APPHX_HOST_PID must be a positive PID. ${guidance}`);
    if (target === 1 || target === process.pid) throw new Error(`The host owner must be a live controller ancestor, not this CLI or PID 1. ${guidance}`);
  }
  const parent = process.ppid;
  const ancestors = new Map<number, ProcessInfo>();
  const inspect = (pid: number): ProcessInfo => {
    if (pid <= 1 || ancestors.has(pid) || ancestors.size >= 64) throw new Error(`Cannot establish a live host ancestor without crossing the process-tree boundary. ${guidance}`);
    const info = inspectProcess(pid);
    if (!info?.identity || !processIsAlive(pid)) throw new Error(`Cannot inspect live host ancestor ${pid}. ${guidance}`);
    ancestors.set(pid, info);
    return info;
  };
  let ownerPid = parent;
  let owner = inspect(ownerPid);
  while (true) {
    if (target !== undefined) {
      if (ownerPid === target) break;
    } else {
      const kind = processKind(owner);
      if (kind === 'host') break;
      if (kind === 'unknown') throw new Error(`Cannot safely recognize host launcher ${ownerPid}. ${guidance}`);
      if (kind === 'shell') {
        ownerPid = owner.parentPid;
        owner = inspect(ownerPid);
        if (processKind(owner) !== 'wrapper') throw new Error(`A noninteractive shell is not a persistent host and its launcher is not a recognized package-manager execution. ${guidance}`);
      }
    }
    ownerPid = owner.parentPid;
    owner = inspect(ownerPid);
  }
  // Reject death, PID reuse or reparenting during the ancestry walk. The runner
  // independently obtains the incarnation again when it commits a claim/adoption.
  if (process.ppid !== parent) throw new Error(`Host ancestry changed while resolving ownership. ${guidance}`);
  for (const [pid, previous] of ancestors) {
    const current = inspectProcess(pid);
    if (!current || current.identity !== previous.identity || current.parentPid !== previous.parentPid || !processIsAlive(pid)) throw new Error(`Host ancestor ${pid} changed or exited while resolving ownership. ${guidance}`);
  }
  return { ownerPid, ownerIdentity: owner.identity };
}
