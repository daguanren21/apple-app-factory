#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveHash, FRAMEWORKS } from './common.js';
import type { Framework } from './common.js';
import { ObfuscatorConfigSchema } from './config.js';
import { applyObfuscation } from './obfuscate.js';

const help = `apphx-obfuscator --project <dir> [--config <config.json>] [--framework <stack>] [--seed <text>]
  Deterministically obfuscates an owned app project in place.
  --project <dir>      Existing project directory to transform (required)
  --config <file>      Obfuscator options as JSON; defaults to all features off
  --framework <stack>  flutter|android-java|swift|react-native|expo|uni-app|mygo (required unless set in config)
  --seed <text>        Determinism seed; defaults to config.seed, then a hash of the config file
  --version            Print the package version
Exit codes: 0 transformed; 1 transform failure; 2 configuration or usage error.
Report is printed to stdout as JSON: { changedFiles, transforms, skipped }`;

function usageError(message: string): never {
  console.error(JSON.stringify({ error: message }));
  console.error(help);
  process.exitCode = 2;
  throw new Error(message);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    allowPositionals: false,
    options: {
      project: { type: 'string' },
      config: { type: 'string' },
      framework: { type: 'string' },
      seed: { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.version) {
    const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    console.log(metadata.version);
    return;
  }
  if (values.help || !values.project) { console.log(help); if (!values.project) process.exitCode = 2; return; }
  const configPath = values.config ? resolve(values.config) : undefined;
  const raw = configPath ? readFileSync(configPath, 'utf8') : '{}';
  const parsed = ObfuscatorConfigSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) usageError(`Invalid obfuscator configuration: ${parsed.error.issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ')}`);
  const config = parsed.data;
  const frameworkValue = values.framework ?? config.framework;
  if (!frameworkValue || !FRAMEWORKS.includes(frameworkValue as Framework)) usageError(`--framework must be one of ${FRAMEWORKS.join('|')}`);
  const framework = frameworkValue as Framework;
  const seed = values.seed ?? config.seed ?? deriveHash(JSON.stringify(config)).slice(0, 16);
  const report = applyObfuscation(resolve(values.project), config, seed, framework);
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ error: message }));
  process.exitCode = process.exitCode === 2 ? 2 : 1;
});
