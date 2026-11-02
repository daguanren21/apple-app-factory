import type { z } from 'zod';
import { FrameworkSchema, PackageTargetSchema, PlatformSchema } from '../contracts/schemas.js';
import type { ConfigSchema, Framework, PackageTarget, Platform } from '../contracts/schemas.js';

/** Portable starter input; project/control identity is selected by the CLI owner. */
export type PlatformProfile = Omit<z.input<typeof ConfigSchema>, 'configPath' | 'stateDir' | 'workspaceRoot'>;

/** Fresh configuration data only. No files, SDKs, examples or commands are read or executed. */
export function createPlatformProfile(framework: Framework, platform: Platform, target: PackageTarget): PlatformProfile {
  FrameworkSchema.parse(framework);
  PlatformSchema.parse(platform);
  PackageTargetSchema.parse(target);
  if ((framework === 'mygo') !== (platform === 'macos')) throw new Error(`${framework} does not support ${platform}`);
  if ((framework === 'android-java' && platform !== 'android') || (framework === 'swift' && platform !== 'ios')) throw new Error(`${framework} does not support ${platform}`);
  const allowedTargets = platform === 'macos' ? ['app', 'dmg'] : platform === 'ios' ? ['simulator', 'ipa'] : ['apk', 'aab'];
  if (!allowedTargets.includes(target)) throw new Error(`${target} does not match platform ${platform}`);

  let executionEnv: string[];
  let verification: PlatformProfile['verification'];
  let packaging: PlatformProfile['packaging'];
  if (framework === 'mygo') {
    executionEnv = [];
    verification = {
      prerequisites: [['go', 'version'], ['go', 'tool', 'mygo', 'version']],
      checks: [['go', 'vet', './...'], ['go', 'test', './...']],
      runtime: [['go', 'run', './cmd/acceptance']],
    };
    packaging = {
      provider: 'local',
      commands: [['go', 'tool', 'mygo', 'build', '-platform', 'darwin/arm64', '-sign', '-', '-skip-notarize', ...(target === 'app' ? ['-skip-dmg'] : []), '-o', 'build']],
      artifactPath: target === 'app' ? 'build/darwin-arm64/MyGo App.app' : 'build/darwin-arm64/MyGo App 0.1.0.dmg',
    };
  } else if (framework === 'flutter') {
    executionEnv = platform === 'ios' ? ['IOS_DEVICE_ID'] : ['ANDROID_DEVICE_ID'];
    verification = {
      prerequisites: platform === 'ios' ? [['xcodebuild', '-version']] : [['java', '-version'], ['adb', 'version']],
      checks: [['flutter', 'analyze', '--fatal-infos'], ['flutter', 'test']],
      runtime: [['flutter', 'drive', '--driver', 'test_driver/integration_test.dart', '--target', 'integration_test/app_test.dart', '-d', platform === 'ios' ? '${IOS_DEVICE_ID}' : '${ANDROID_DEVICE_ID}', '--no-pub']],
    };
  } else if (framework === 'expo') {
    const device = platform === 'ios' ? 'IOS_DEVICE_ID' : 'ANDROID_DEVICE_ID';
    const profile = target === 'simulator' ? 'simulator' : target === 'apk' ? 'apk' : 'production';
    const output = target === 'simulator' ? 'build/simulator.tar.gz' : `build/app.${target}`;
    executionEnv = [device, ...(platform === 'android' ? ['ANDROID_HOME'] : [])];
    verification = {
      prerequisites: [['node', '--version'], ['eas', '--version']],
      checks: [['npm', 'run', 'lint'], ['npm', 'test', '--', '--runInBand']],
      runtime: [['npm', 'run', 'test:e2e', '--', '--platform', platform, '--device', '${' + device + '}']],
    };
    packaging = {
      provider: 'local',
      commands: [['eas', 'build', '--platform', platform, '--profile', profile, '--local', '--non-interactive', '--output', output], ...(target === 'simulator' ? [['tar', '-xzf', output, '-C', 'build']] : [])],
      artifactPath: target === 'simulator' ? 'build/App.app' : output,
    };
  } else if (platform === 'ios' && (framework === 'swift' || framework === 'react-native' || framework === 'uni-app')) {
    const native = framework === 'swift' ? '.' : framework === 'uni-app' ? 'native/ios' : 'ios';
    const project = framework === 'swift' ? ['-project', 'App.xcodeproj'] : ['-workspace', `${native}/App.xcworkspace`];
    const base = ['xcodebuild', ...project, '-scheme', 'App'];
    executionEnv = ['IOS_DEVICE_ID'];
    verification = {
      prerequisites: [['xcodebuild', '-version'], ...(framework === 'swift' ? [] : [['node', '--version'], ['npm', '--version']])],
      checks: framework === 'swift' ? [[...base, 'build-for-testing', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', 'build/DerivedData']] : [['npm', 'run', 'lint'], ['npm', 'test', '--', '--runInBand']],
      runtime: framework === 'swift' ? [[...base, 'test-without-building', '-destination', 'id=${IOS_DEVICE_ID}', '-derivedDataPath', 'build/DerivedData']] : [['npm', 'run', 'test:e2e', '--', '--platform', 'ios', '--device', '${IOS_DEVICE_ID}']],
    };
    packaging = target === 'simulator' ? {
      commands: [[...base, 'build', '-configuration', 'Debug', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', 'build/DerivedData']],
      artifactPath: 'build/DerivedData/Build/Products/Debug-iphonesimulator/App.app', provider: 'local',
    } : {
      commands: [[...base, 'archive', '-configuration', 'Release', '-destination', 'generic/platform=iOS', '-archivePath', 'build/App.xcarchive'], ['xcodebuild', '-exportArchive', '-archivePath', 'build/App.xcarchive', '-exportPath', 'build/export', '-exportOptionsPlist', 'ExportOptions.plist']],
      artifactPath: 'build/export/App.ipa', provider: 'local',
    };
  } else if (framework === 'android-java') {
    executionEnv = ['ANDROID_HOME', 'ANDROID_SERIAL'];
    verification = {
      prerequisites: [['java', '-version'], ['adb', 'version']],
      checks: [['./gradlew', ':app:lintDebug', ':app:testDebugUnitTest']],
      runtime: [['./gradlew', ':app:connectedDebugAndroidTest']],
    };
    packaging = {
      provider: 'local', commands: [['./gradlew', target === 'apk' ? ':app:assembleRelease' : ':app:bundleRelease']],
      artifactPath: `app/build/outputs/${target === 'apk' ? 'apk/release/app-release.apk' : 'bundle/release/app-release.aab'}`,
    };
  } else if (framework === 'react-native' || framework === 'uni-app') {
    const native = framework === 'uni-app' ? 'native/android' : 'android';
    executionEnv = ['ANDROID_HOME', 'ANDROID_DEVICE_ID'];
    verification = {
      prerequisites: [['node', '--version'], ['java', '-version'], ['adb', 'version']],
      checks: [['npm', 'run', 'lint'], ['npm', 'test', '--', '--runInBand']],
      runtime: [['npm', 'run', 'test:e2e', '--', '--platform', 'android', '--device', '${ANDROID_DEVICE_ID}']],
    };
    packaging = {
      provider: 'local', commands: [[`./${native}/gradlew`, '-p', native, target === 'apk' ? ':app:assembleRelease' : ':app:bundleRelease']],
      artifactPath: `${native}/app/build/outputs/${target === 'apk' ? 'apk/release/app-release.apk' : 'bundle/release/app-release.aab'}`,
    };
  } else {
    throw new Error(`Unsupported profile ${framework}/${platform}/${target}`);
  }
  return {
    projectMode: 'project', projectRoot: '.', allowLocalExecution: false, allowCloudBuild: false,
    packageTarget: target, obfuscation: { options: { code: { removeComments: true } } },
    executionEnv, verification, ...(packaging ? { packaging } : {}), workflow: {}, maxHostTurns: 64, uiQuality: true,
  };
}
