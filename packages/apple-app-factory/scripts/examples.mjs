import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ConfigSchema, FrameworkSchema, RequirementSchema, validateJobConfig } from '../dist/contracts/schemas.js';
import { createPlatformProfile } from '../dist/configuration/profiles.js';
import { RemoteSchema } from '../dist/hosts/remote.js';

const args = process.argv.slice(2);
if (args.length !== 1 || !['--write', '--check'].includes(args[0])) throw new Error('Usage: node scripts/examples.mjs --write|--check (build apphx first)');
const directory = fileURLToPath(new URL('../examples/', import.meta.url));
const readJSON = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const generated = new Map();
const scenarios = [
  ['factory.json', 'luggage.json'],
  ['existing-project.factory.json', 'existing-project.json'],
  ['mygo-web.factory.json', 'mygo-web.json'],
];
for (const framework of FrameworkSchema.options) {
  // Example targets illustrate local iOS/desktop and Android release bundles;
  // these choices are documentation, not init's default platform/target policy.
  const platform = framework === 'mygo' ? 'macos' : ['flutter', 'swift'].includes(framework) ? 'ios' : 'android';
  const target = platform === 'macos' ? 'app' : platform === 'ios' ? 'simulator' : 'aab';
  const name = `${framework}.factory.json`;
  generated.set(name, createPlatformProfile(framework, platform, target));
  scenarios.push([name, `${framework}.json`]);
}

// Validate all apphx examples through the existing runtime contracts before
// writing any generated output. No directory resolution, SDK probe or execution.
for (const [configName, requirementName] of scenarios) {
  const input = generated.get(configName) ?? readJSON(configName);
  const config = ConfigSchema.parse({ stateDir: '.factory', workspaceRoot: 'workspaces', ...input });
  const requirement = RequirementSchema.parse(readJSON(requirementName));
  validateJobConfig(requirement, config);
}
RemoteSchema.parse(readJSON('remote.json'));
// These formats belong to the host and Expo, not ConfigSchema/RequirementSchema.
const foreignExamples = ['roles.example.json', 'expo.eas.json'];
for (const name of foreignExamples) readJSON(name);
const known = new Set([...scenarios.flat(), 'remote.json', ...foreignExamples]);
for (const name of readdirSync(directory)) {
  if (name.endsWith('.json') && !known.has(name)) throw new Error(`Unclassified example ${name}; register its owning contract before shipping it`);
}

const drift = [];
for (const [name, value] of generated) {
  if (args[0] === '--write') {
    writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n');
  } else if (!isDeepStrictEqual(readJSON(name), value)) {
    drift.push(name);
  }
}
if (drift.length) throw new Error(`Generated starter examples drifted: ${drift.join(', ')}. Run pnpm --filter apphx run examples:generate; do not edit generated defaults`);
console.log(`${args[0] === '--write' ? 'Generated' : 'Checked'} ${generated.size} starter profiles; validated ${scenarios.length} apphx scenario pairs and the remote example. Host-role and Expo EAS examples are JSON-only foreign formats.`);
