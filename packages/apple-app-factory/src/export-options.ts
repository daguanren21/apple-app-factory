import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Run } from './process.js';

const ExportOptionsSchema = z.object({ destination: z.literal('export').default('export') }).passthrough();

export async function prepareExportOptions(source: string, stateDir: string, run: Run): Promise<{ directory: string; path: string }> {
  const decoded = await run(['/usr/bin/plutil', '-convert', 'json', '-o', '-', source]);
  if (decoded.code !== 0) throw Object.assign(new Error(`Cannot read IPA export options: ${decoded.stderr || decoded.stdout}`), { code: 'SETUP_REQUIRED' });
  let input: unknown;
  try { input = JSON.parse(decoded.stdout) as unknown; }
  catch { throw Object.assign(new Error('IPA export options did not decode to valid JSON'), { code: 'SETUP_REQUIRED' }); }
  const options = ExportOptionsSchema.safeParse(input);
  if (!options.success) throw Object.assign(new Error('IPA packaging only permits destination=export; destination=upload would bypass publication permission. Use local export options.'), { code: 'SETUP_REQUIRED' });
  const directory = mkdtempSync(join(stateDir, 'export-options-'));
  try {
    const path = join(directory, 'ExportOptions.plist');
    writeFileSync(path, JSON.stringify(options.data), { mode: 0o600 });
    const converted = await run(['/usr/bin/plutil', '-convert', 'xml1', path]);
    if (converted.code !== 0) throw Object.assign(new Error(`Cannot prepare local IPA export options: ${converted.stderr || converted.stdout}`), { code: 'SETUP_REQUIRED' });
    return { directory, path };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

// Prepare the entire sequence before executing any owner-configured packaging command.
// This guards recognizable native exports, not arbitrary scripts or executable code.
export async function prepareNativeExportCommands(commands: string[][], cwd: string, stateDir: string, run: Run): Promise<{ commands: string[][]; readableFiles: string[]; cleanup: () => void }> {
  const prepared = commands.map(argv => [...argv]);
  const directories: string[] = [];
  const readableFiles: string[] = [];
  const cleanup = () => { for (const directory of directories) rmSync(directory, { recursive: true, force: true }); };
  const ambiguous = () => Object.assign(new Error('Native IPA export requires exactly one unambiguous -exportOptionsPlist path; use direct xcodebuild or xcrun xcodebuild arguments.'), { code: 'SETUP_REQUIRED' });
  try {
    for (const argv of prepared) {
      const executable = basename(argv[0] ?? '');
      const direct = executable === 'xcodebuild';
      const wrapped = executable === 'xcrun' && basename(argv[1] ?? '') === 'xcodebuild';
      if (!direct && !wrapped) {
        if (executable === 'xcrun' && argv.some(value => basename(value) === 'xcodebuild') && argv.includes('-exportArchive')) throw ambiguous();
        continue;
      }
      const args = argv.slice(wrapped ? 2 : 1);
      if (!args.some(value => value.startsWith('-exportArchive'))) continue;
      if (args.filter(value => value === '-exportArchive').length !== 1 || args.some(value => value.startsWith('-exportArchive') && value !== '-exportArchive')) throw ambiguous();
      const flags = args.filter(value => value.startsWith('-exportOptionsPlist'));
      const index = argv.indexOf('-exportOptionsPlist');
      const source = argv[index + 1];
      if (flags.length !== 1 || flags[0] !== '-exportOptionsPlist' || index < 0 || !source || source.startsWith('-') || args.includes('--')) throw ambiguous();
      const snapshot = await prepareExportOptions(resolve(cwd, source), stateDir, run);
      directories.push(snapshot.directory);
      readableFiles.push(snapshot.path);
      argv[index + 1] = snapshot.path;
    }
    return { commands: prepared, readableFiles, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
