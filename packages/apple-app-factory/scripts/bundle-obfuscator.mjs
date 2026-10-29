import { chmodSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundle the private obfuscator into this package so installing apphx also provides the
// `obfuscator` executable and the harness can resolve its default obfuscation command.
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const source = join(packageRoot, '..', 'obfuscator');
const target = join(packageRoot, 'dist', 'vendor', 'obfuscator');

if (!existsSync(join(source, 'dist', 'cli.js'))) {
  console.error('obfuscator dist is missing; build packages/obfuscator first (turbo orders this via the workspace dependency)');
  process.exit(1);
}
mkdirSync(dirname(target), { recursive: true });
cpSync(join(source, 'package.json'), join(target, 'package.json'));
cpSync(join(source, 'dist'), join(target, 'dist'), { recursive: true });
chmodSync(join(target, 'dist', 'cli.js'), 0o755);
console.log(`bundled obfuscator into ${target}`);
