import { basename, join } from 'node:path';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { artifactOutputPath } from './workspace.js';
import type { Run } from './process.js';


/** Validate native output with system tooling, not just the file extension. */
export async function validateMacOSArtifact(path: string, target: 'app' | 'dmg', exec: Run): Promise<void> {
  if (target === 'dmg') {
    const result = await exec(['/usr/bin/hdiutil', 'verify', path]);
    if (result.code !== 0) throw new Error(`Invalid macOS disk image: ${result.stderr || result.stdout}`);
    return;
  }
  const info = artifactOutputPath(path, 'Contents/Info.plist');
  if (!lstatSync(info).isFile()) throw new Error('macOS application requires a regular Contents/Info.plist');
  const result = await exec(['/usr/bin/plutil', '-extract', 'CFBundleExecutable', 'raw', '-o', '-', info]);
  const executable = result.stdout.trim();
  if (result.code !== 0 || !executable || executable === '.' || executable === '..' || basename(executable) !== executable || executable.includes('\\')) throw new Error('macOS Info.plist must identify an in-bundle executable by file name');
  const binary = artifactOutputPath(path, join('Contents', 'MacOS', executable));
  const stat = lstatSync(binary);
  if (!stat.isFile() || stat.size < 32 || !(stat.mode & 0o111)) throw new Error('macOS application executable is missing, empty or not executable');
  const header = Buffer.allocUnsafe(4);
  const descriptor = openSync(binary, 'r');
  try {
    if (readSync(descriptor, header, 0, 4, 0) !== 4 || !['feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))) throw new Error('macOS application executable must be a Mach-O binary, not a script or placeholder');
  } finally { closeSync(descriptor); }
  const signed = await exec(['/usr/bin/codesign', '--verify', '--deep', '--strict', path]);
  if (signed.code !== 0) throw new Error(`macOS local application signature is invalid: ${signed.stderr || signed.stdout}`);
}
