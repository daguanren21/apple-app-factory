import { resolve } from 'node:path';
import { run, agentEnvironment } from './process.js';
import { ProviderSchema, toError } from './schemas.js';
import type { Provider, Config } from './schemas.js';

export const providerKinds = ProviderSchema.shape.kind.options;

const executables = { codex: 'codex', cursor: 'agent', pi: 'pi', deepseek: 'dsh' };

function optionalString(value: unknown, name: string): asserts value is string | undefined { if (value === undefined) return;
if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
  throw new Error(`${name} must be a non-empty string without NUL characters`);
} }

function configuration(provider: unknown) {
  const parsed = ProviderSchema.parse(provider);
  return { ...parsed, executable: parsed.executable ?? executables[parsed.kind] };
}

export function providerCommand(provider: unknown, { prompt, cwd, readOnly = false, outputPath, environment }: { prompt?: string; cwd?: string; readOnly?: boolean; outputPath?: string; environment?: NodeJS.ProcessEnv } = {}): { argv: string[]; input?: string; outputPath?: string } {
  const config = configuration(provider);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Agent prompt must be a non-empty string');
  optionalString(cwd, 'Agent working directory');
  optionalString(outputPath, 'Agent final response path');
  if (cwd === undefined) throw new Error('Agent working directory is required');
  if (typeof readOnly !== 'boolean') throw new Error('Agent readOnly must be a boolean');
  const root = resolve(cwd);
  const argv = [config.executable];

  if (config.kind === 'codex') {
    argv.push('--ask-for-approval', 'never', 'exec', '--sandbox', readOnly ? 'read-only' : 'workspace-write', '--cd', root, '--skip-git-repo-check');
    if (config.model !== undefined) argv.push('--model', config.model);
    if (config.provider !== undefined) argv.push('--config', `model_provider=${JSON.stringify(config.provider)}`);
    if (outputPath !== undefined) argv.push('--output-last-message', outputPath);
    for (const key of ['CI', 'PATH', 'FLUTTER_ROOT', 'PUB_CACHE', 'ANALYZER_STATE_LOCATION_OVERRIDE', 'DART_SUPPRESS_ANALYTICS', 'FLUTTER_SUPPRESS_ANALYTICS']) {
      if (environment?.[key] !== undefined) {
        optionalString(environment[key], `Agent environment ${key}`);
        argv.push('--config', `shell_environment_policy.set.${key}=${JSON.stringify(environment[key])}`);
      }
    }
    argv.push('-');
    return { argv, input: prompt, outputPath };
  }

  if (config.kind === 'cursor') {
    if (readOnly) {
      throw new Error('Cursor read-only execution is unsupported: Ask mode is not a filesystem read-only sandbox; select Codex, Pi restricted tools, or DeepSeek Harness for review');
    }
    argv.push('--print', '--output-format', 'text', '--sandbox', 'enabled', '--force', '--trust', '--workspace', root);
    if (config.model !== undefined) argv.push('--model', config.model);
    argv.push('--', prompt);
    return { argv };
  }

  if (config.kind === 'pi') {
    argv.push('--print', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--tools', readOnly ? 'read,grep,find,ls' : 'read,bash,edit,write,grep,find,ls');
    if (config.provider !== undefined) argv.push('--provider', config.provider);
    if (config.model !== undefined) argv.push('--model', config.model);
    return { argv, input: prompt };
  }

  argv.push('--profile', 'headless', '--permission-mode', readOnly ? 'read-only' : 'workspace-write', '--approval-policy', 'never', '-');
  return { argv, input: prompt };
}

export async function probeProvider(provider: Provider, probeConfig: Pick<Config, 'agentEnv'> = { agentEnv: [] }) { const config = configuration(provider);
const args = config.kind === 'codex' ? ['exec', '--help']
  : config.kind === 'pi' ? ['--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--offline', '--help']
    : ['--help'];
let result;
try {
  result = await run([config.executable, ...args], { env: agentEnvironment(probeConfig), timeoutMs: 15000 });
} catch (cause) {
  const error = toError(cause);
  if (error.code === 'ENOENT') {
    return { available: false, detail: `${config.kind} executable not found: ${config.executable}. Install the coding CLI or set executable to its installed path.` };
  }
  return { available: false, detail: `${config.kind} executable could not complete its help probe: ${error.message}. Authentication was not checked.` };
}
if (result.code !== 0) {
  const reason = result.stderr.trim() || result.stdout.trim() || 'No diagnostic output';
  return {
    available: false,
    detail: `${config.kind} executable was reached, but its help probe exited ${result.code}: ${reason}. Check executable and wrapper compatibility; use executable to select the real CLI. Authentication was not checked.`,
  };
}
const help = `${result.stdout}\n${result.stderr}`;
const required = {
  codex: ['--sandbox', 'read-only', 'workspace-write', '--cd', '--skip-git-repo-check', '--output-last-message'],
  cursor: ['--print', '--output-format', '--sandbox', '--force', '--trust', '--workspace', '--model'],
  pi: ['--print', '--no-session', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-approve', '--tools', '--provider', '--model'],
  deepseek: ['--profile', '--patch'],
}[config.kind];
const missing = required.filter(flag => !help.includes(flag));
if (missing.length) {
  return { available: false, detail: `${config.kind} executable was reached, but its help does not advertise required capabilities: ${missing.join(', ')}. Select a compatible coding CLI. Authentication was not checked.` };
}
const boundary = {
  codex: 'Read-only and workspace-write sandbox options are advertised.',
  cursor: 'Builder only; shell sandbox is enabled, but Cursor Ask mode is not accepted as read-only confinement. Configured plugins and MCP servers retain their own authority.',
  pi: 'Read-only runs restrict tools and disable extensions and MCP. Write runs execute with the operating-system user permissions; Pi provides no OS sandbox.',
  deepseek: 'Launcher is reachable; headless profile, permission presets, sandbox backend, and model configuration are checked only when a task runs. Profiles may initialize on first use.',
}[config.kind];
return { available: true, detail: `${config.kind} help probe succeeded. ${boundary} Authentication, model availability, and successful task execution were not checked.` }; }
