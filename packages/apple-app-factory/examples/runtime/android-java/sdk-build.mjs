import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

const sdk = process.env.ANDROID_SDK_ROOT;
const java = process.env.JAVA_HOME;
if (!sdk || !java) throw new Error('ANDROID_SDK_ROOT and JAVA_HOME must select installed SDK/JDK; this driver never installs tools or accepts licenses');
const tools = join(sdk, 'build-tools', process.env.APPHX_ANDROID_BUILD_TOOLS ?? '35.0.0');
const android = join(sdk, 'platforms', process.env.APPHX_ANDROID_PLATFORM ?? 'android-35', 'android.jar');
const build = resolve('build');
mkdirSync(join(build, 'classes'), { recursive: true });
mkdirSync(join(build, 'dex'), { recursive: true });
function run(executable, args, cwd = process.cwd()) {
  const result = spawnSync(executable, args, { cwd, env: process.env, encoding: 'utf8', timeout: 120000 });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${executable} exited ${result.status}`);
}
const unsigned = join(build, 'unsigned.apk');
rmSync(unsigned, { force: true });
run(join(tools, 'aapt'), ['package', '-f', '-M', 'app/src/main/AndroidManifest.xml', '-I', android, '-F', unsigned]);
run(join(java, 'bin/javac'), ['-source', '8', '-target', '8', '-bootclasspath', [android, join(tools, 'core-lambda-stubs.jar')].join(delimiter), '-d', join(build, 'classes'), 'app/src/main/java/dev/apphx/runtime/MainActivity.java']);
run(join(tools, 'd8'), ['--lib', android, '--min-api', '23', '--output', join(build, 'dex'), join(build, 'classes/dev/apphx/runtime/MainActivity.class')]);
run('/usr/bin/zip', ['-q', unsigned, 'classes.dex'], join(build, 'dex'));
run(join(tools, 'zipalign'), ['-f', '4', unsigned, join(build, 'aligned.apk')]);
const key = join(build, 'local-only.p12');
if (!existsSync(key)) run(join(java, 'bin/keytool'), ['-genkeypair', '-keystore', key, '-storepass', 'local-smoke-only', '-keypass', 'local-smoke-only', '-alias', 'smoke', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-dname', 'CN=Local runtime smoke']);
run(join(tools, 'apksigner'), ['sign', '--ks', key, '--ks-pass', 'pass:local-smoke-only', '--out', join(build, 'records.apk'), join(build, 'aligned.apk')]);
run(join(tools, 'apksigner'), ['verify', '--verbose', '--print-certs', join(build, 'records.apk')]);
run(join(tools, 'aapt'), ['dump', 'badging', join(build, 'records.apk')]);
