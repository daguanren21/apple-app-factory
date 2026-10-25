import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
