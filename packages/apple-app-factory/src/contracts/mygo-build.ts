import { basename, posix } from 'node:path';
import type { Config } from './schemas.js';

/** Accept a direct, local MyGo build, never a wrapper that can add publishing flags. */
export function validateMyGoPackaging(config: Config, screenshotsDir?: string): void {
  const profile = config.packaging;
  if (!profile || profile.provider !== 'local' || profile.commands.length !== 1) throw Object.assign(new Error('MyGo requires one direct local build command'), { code: 'SETUP_REQUIRED' });
  const argv = profile.commands[0]!;
  let start: number;
  if (basename(argv[0]!) === 'mygo' && argv[1] === 'build') start = 2;
  else if (basename(argv[0]!) === 'go' && argv[1] === 'tool' && argv[2] === 'mygo' && argv[3] === 'build') start = 4;
  else if (basename(argv[0]!) === 'go' && argv[1] === 'run' && /^github\.com\/egoist\/mygo\/cmd\/mygo@v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(argv[2] ?? '') && argv[3] === 'build') start = 4;
  else throw Object.assign(new Error('MyGo packaging must use a pinned go tool mygo build, installed mygo build, or version-pinned go run command'), { code: 'SETUP_REQUIRED' });
  const flags = new Map<string, string>();
  for (let index = start; index < argv.length; index++) {
    const flag = argv[index]!;
    if (flags.has(flag)) throw Object.assign(new Error(`Duplicate MyGo build flag: ${flag}`), { code: 'SETUP_REQUIRED' });
    if (flag === '-sign' || flag === '-platform' || flag === '-o') {
      const value = argv[++index];
      if (!value) throw Object.assign(new Error(`Missing MyGo flag value: ${flag}`), { code: 'SETUP_REQUIRED' });
      flags.set(flag, value);
    } else if (flag === '-skip-notarize' || flag === '-skip-dmg' || flag === '-skip-build-command') flags.set(flag, 'true');
    else throw Object.assign(new Error(`MyGo local packaging does not permit ${flag}; upload, notarization and custom wrapper commands are out of scope`), { code: 'SETUP_REQUIRED' });
  }
  if (flags.get('-sign') !== '-' || !flags.has('-skip-notarize')) throw Object.assign(new Error('MyGo local builds require -sign - and -skip-notarize, even when project configuration enables signing/notarization'), { code: 'SETUP_REQUIRED' });
  const platform = flags.get('-platform');
  if (!platform || !/^darwin\/(?:arm64|amd64|universal)$/.test(platform)) throw Object.assign(new Error('MyGo packaging requires one explicit darwin/arm64, darwin/amd64 or darwin/universal target'), { code: 'SETUP_REQUIRED' });
  if (flags.get('-o') !== 'build') throw Object.assign(new Error('MyGo packaging requires -o build so output cannot replace project source'), { code: 'SETUP_REQUIRED' });
  const prefix = `build/${platform.replace('/', '-')}/`;
  if (!profile.artifactPath.startsWith(prefix)) throw Object.assign(new Error(`MyGo artifactPath must be inside ${prefix}`), { code: 'SETUP_REQUIRED' });
  if (screenshotsDir !== undefined) {
    const screenshot = posix.normalize(screenshotsDir);
    if (posix.isAbsolute(screenshot) || screenshot === '..' || screenshot.startsWith('../') || screenshot.includes('\\')) throw Object.assign(new Error('MyGo screenshotsDir must stay within the selected project'), { code: 'SETUP_REQUIRED' });
    const outputDirectory = prefix.slice(0, -1);
    if ([posix.relative(outputDirectory, screenshot), posix.relative(screenshot, outputDirectory)].some(path => path === '' || path !== '..' && !path.startsWith('../') && !posix.isAbsolute(path))) throw Object.assign(new Error('MyGo screenshotsDir must not overlap the platform output directory replaced during packaging'), { code: 'SETUP_REQUIRED' });
  }
  if (config.packageTarget === 'app' ? !flags.has('-skip-dmg') : flags.has('-skip-dmg')) throw Object.assign(new Error('MyGo app builds require -skip-dmg; dmg builds must create the disk image'), { code: 'SETUP_REQUIRED' });
}

/** Doctor and tracked execution share the same gate for every recognizable direct build. */
export function validateMyGoCommand(config: Config, argv: string[]): void {
  const tool = basename(argv[0] ?? '');
  const buildIndex = argv.indexOf('build');
  if (buildIndex <= 0) return;
  const direct = tool === 'mygo' || tool === 'go' && argv.slice(1, buildIndex).some(value => value === 'mygo' || value === 'github.com/egoist/mygo/cmd/mygo' || value.startsWith('github.com/egoist/mygo/cmd/mygo@'));
  if (!direct) return;
  validateMyGoPackaging({ ...config, packageTarget: argv.includes('-skip-dmg') ? 'app' : 'dmg', packaging: config.packaging ? { ...config.packaging, commands: [argv] } : undefined });
}
