#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor');
const PACKAGE = join(VENDOR, 'pi-schema');
const ARTIFACT = join(VENDOR, 'pi-schema.tgz');
const PROVENANCE = join(VENDOR, 'pi-schema.provenance.json');
const COMMIT = 'c9f4c7b9fcd0f3e6b5bbc35c7c9b6cda35580eb8';
const PACKAGE_VERSION = `1.4.0-apphx.${COMMIT.slice(0, 12)}`;
const ARCHIVE_URL = `https://codeload.github.com/earendil-works/pi/tar.gz/${COMMIT}`;
const ARCHIVE_SHA256 = 'a68fe5377a5a8c05aed9174f99d381c64e7b1220bdee49184e58fb7b51689c0f';
const ARCHIVE_ROOT = `pi-${COMMIT}`;
const PACKAGE_SOURCE = `${ARCHIVE_ROOT}/packages/schema`;
const PACKAGE_JSON = {
  name: '@earendil-works/pi-schema',
  version: PACKAGE_VERSION,
  description: 'JSON Schema validation without eval (source-pinned apphx artifact)',
  type: 'module',
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    './formats': { types: './dist/formats/index.d.ts', import: './dist/formats/index.js' },
  },
  sideEffects: false,
  files: ['dist', 'README.md', 'CHANGELOG.md', 'LICENSE', 'LICENSES'],
  author: 'Earendil Works',
  license: 'MIT',
  repository: {
    type: 'git',
    url: 'git+https://github.com/earendil-works/pi.git',
    directory: 'packages/schema',
  },
  engines: { node: '>=22.19.0' },
};
const BUILD_TSCONFIG = {
  compilerOptions: {
    target: 'ES2024',
    module: 'Node16',
    lib: ['ES2024'],
    strict: true,
    erasableSyntaxOnly: true,
    verbatimModuleSyntax: true,
    esModuleInterop: true,
    skipLibCheck: true,
    forceConsistentCasingInFileNames: true,
    declaration: true,
    declarationMap: true,
    sourceMap: true,
    inlineSources: true,
    inlineSourceMap: false,
    moduleResolution: 'Node16',
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
    types: ['node'],
    rootDir: './src',
    outDir: './dist',
  },
  include: ['src/**/*.ts'],
  exclude: ['node_modules', 'dist', '**/*.d.ts', 'src/**/*.d.ts'],
};

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlobSha1(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

function gitBlobSha1File(path) {
  return gitBlobSha1(readFileSync(path));
}

function stableFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Unsupported source entry: ${path}`);
    }
  };
  visit(root);
  return files;
}

function sourceTree(root) {
  const files = stableFiles(root).map((path) => ({
    path: relative(root, path).split('\\').join('/'),
    bytes: readFileSync(path),
  }));
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file.path).update('\0').update(file.bytes).update('\0');
  }
  const entries = files.map(({ path, bytes }) => ({
    path,
    bytes: bytes.length,
    sha256: sha256Bytes(bytes),
    gitBlobSha1: gitBlobSha1(bytes),
    imports: [...new Set([...bytes.toString('utf8').matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)].map((match) => match[2]))].sort(),
  }));
  const externalImports = [...new Set(entries.flatMap((entry) => entry.imports).filter((specifier) => !specifier.startsWith('.')))];
  if (externalImports.length > 0) throw new Error(`Unexpected external schema imports: ${externalImports.join(', ')}`);
  return { sha256: digest.digest('hex'), files: entries };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C', SOURCE_DATE_EPOCH: '0' },
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  return result;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function downloadArchive(destination) {
  const response = await fetch(ARCHIVE_URL, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Unable to fetch pinned archive: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  writeFileSync(destination, bytes);
}

function verifyArchive(path) {
  const actual = sha256File(path);
  if (actual !== ARCHIVE_SHA256) {
    throw new Error(`Pinned archive hash mismatch: expected ${ARCHIVE_SHA256}, got ${actual}`);
  }
}

function copyPinnedSource(archivePath) {
  verifyArchive(archivePath);
  const extractionRoot = mkdtempSync(join(tmpdir(), 'apphx-pi-schema-'));
  try {
    run('tar', ['-xzf', archivePath, '-C', extractionRoot, `${PACKAGE_SOURCE}/src`, `${PACKAGE_SOURCE}/README.md`, `${PACKAGE_SOURCE}/CHANGELOG.md`, `${PACKAGE_SOURCE}/package.json`, `${PACKAGE_SOURCE}/tsconfig.build.json`, `${PACKAGE_SOURCE}/LICENSES/typebox-LICENSE`, `${ARCHIVE_ROOT}/LICENSE`], { stdio: 'ignore' });
    const upstream = join(extractionRoot, PACKAGE_SOURCE);
    if (!existsSync(join(upstream, 'src', 'index.ts'))) throw new Error('Pinned archive has no schema source index');
    rmSync(PACKAGE, { recursive: true, force: true });
    mkdirSync(VENDOR, { recursive: true });
    cpSync(join(upstream, 'src'), join(PACKAGE, 'src'), { recursive: true });
    cpSync(join(upstream, 'README.md'), join(PACKAGE, 'README.md'));
    cpSync(join(upstream, 'CHANGELOG.md'), join(PACKAGE, 'CHANGELOG.md'));
    cpSync(join(upstream, 'LICENSES'), join(PACKAGE, 'LICENSES'), { recursive: true });
    cpSync(join(extractionRoot, ARCHIVE_ROOT, 'LICENSE'), join(PACKAGE, 'LICENSE'));
    cpSync(join(upstream, 'package.json'), join(PACKAGE, 'upstream-package.json'));
    cpSync(join(upstream, 'tsconfig.build.json'), join(PACKAGE, 'upstream-tsconfig.build.json'));
    writeFileSync(join(PACKAGE, 'package.json'), `${JSON.stringify(PACKAGE_JSON, null, 2)}\n`);
    writeFileSync(join(PACKAGE, 'tsconfig.build.json'), `${JSON.stringify(BUILD_TSCONFIG, null, 2)}\n`);
    return {
      upstreamPackage: join(PACKAGE, 'upstream-package.json'),
      upstreamTsconfig: join(PACKAGE, 'upstream-tsconfig.build.json'),
      upstreamLicense: join(PACKAGE, 'LICENSE'),
      upstreamTypeboxLicense: join(PACKAGE, 'LICENSES', 'typebox-LICENSE'),
    };
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function compilerVersion() {
  const packagePath = join(ROOT, 'node_modules', 'typescript', 'package.json');
  if (!existsSync(packagePath)) throw new Error(`Locked TypeScript is unavailable at ${packagePath}`);
  const metadata = readJson(packagePath);
  return { version: metadata.version, packageSha256: sha256File(packagePath) };
}

function buildPackage() {
  rmSync(join(PACKAGE, 'dist'), { recursive: true, force: true });
  run(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(PACKAGE, 'tsconfig.build.json')]);
  const packDir = mkdtempSync(join(tmpdir(), 'apphx-pi-schema-pack-'));
  try {
    run('npm', ['pack', PACKAGE, '--ignore-scripts', '--pack-destination', packDir], { stdio: 'ignore' });
    const names = readdirSync(packDir).filter((name) => name.endsWith('.tgz'));
    if (names.length !== 1) throw new Error(`Expected one npm pack output, found ${names.length}`);
    rmSync(ARTIFACT, { force: true });
    cpSync(join(packDir, names[0]), ARTIFACT);
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

function artifactEntries() {
  const result = spawnSync('tar', ['-tzf', ARTIFACT], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Unable to inspect schema artifact tarball');
  return result.stdout.trim().split('\n').filter(Boolean);
}

function writeProvenance(archivePath, upstreamPaths, compiler) {
  const source = sourceTree(join(PACKAGE, 'src'));
  const upstreamPackage = readJson(join(PACKAGE, 'upstream-package.json'));
  const artifactBytes = readFileSync(ARTIFACT);
  const provenance = {
    format: 1,
    package: {
      name: PACKAGE_JSON.name,
      version: PACKAGE_JSON.version,
      artifact: 'vendor/pi-schema.tgz',
      runtimeDependencies: {},
      lifecycleScriptsExecuted: [],
    },
    upstream: {
      repository: 'https://github.com/earendil-works/pi.git',
      commit: COMMIT,
      packagePath: 'packages/schema',
      archiveUrl: ARCHIVE_URL,
      archiveSha256: sha256File(archivePath),
      archiveExpectedSha256: ARCHIVE_SHA256,
      sourceTreeSha256: source.sha256,
      sourceFiles: source.files,
      upstreamPackageJsonSha256: sha256File(upstreamPaths.upstreamPackage),
      upstreamPackageJsonGitBlobSha1: gitBlobSha1File(upstreamPaths.upstreamPackage),
      upstreamTsconfigBuildSha256: sha256File(upstreamPaths.upstreamTsconfig),
      upstreamTsconfigBuildGitBlobSha1: gitBlobSha1File(upstreamPaths.upstreamTsconfig),
      upstreamLicenseSha256: sha256File(upstreamPaths.upstreamLicense),
      upstreamLicenseGitBlobSha1: gitBlobSha1File(upstreamPaths.upstreamLicense),
      upstreamTypeboxLicenseSha256: sha256File(upstreamPaths.upstreamTypeboxLicense),
      upstreamTypeboxLicenseGitBlobSha1: gitBlobSha1File(upstreamPaths.upstreamTypeboxLicense),
      upstreamLifecycleScripts: upstreamPackage.scripts ?? {},
      sourceImportPolicy: 'All package runtime imports are relative to packages/schema/src; no external runtime dependencies.',
    },
    compiler: {
      name: 'typescript',
      version: compiler.version,
      packageSha256: compiler.packageSha256,
      config: 'vendor/pi-schema/tsconfig.build.json',
      configSha256: sha256File(join(PACKAGE, 'tsconfig.build.json')),
      command: 'node node_modules/typescript/bin/tsc -p vendor/pi-schema/tsconfig.build.json',
    },
    build: {
      sourceMaterializedFromArchive: true,
      upstreamInstallExecuted: false,
      upstreamLifecycleExecuted: false,
      packCommand: 'npm pack vendor/pi-schema --ignore-scripts',
      artifactSha256: sha256Bytes(artifactBytes),
      artifactBytes: artifactBytes.length,
      artifactEntries: artifactEntries(),
    },
    reproduction: {
      command: 'node scripts/build-pi-schema.mjs --rebuild',
      verificationCommand: 'node scripts/build-pi-schema.mjs --verify',
      networkOnlyDuringExplicitRebuild: true,
      normalInstallOrBuildFetchesNetwork: false,
    },
  };
  writeFileSync(PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

function verify() {
  if (!existsSync(PROVENANCE)) throw new Error(`Missing provenance: ${PROVENANCE}`);
  const provenance = readJson(PROVENANCE);
  if (provenance.upstream.commit !== COMMIT) throw new Error('Provenance commit mismatch');
  if (provenance.package.version !== PACKAGE_VERSION) throw new Error('Provenance package version mismatch');
  if (provenance.upstream.archiveSha256 !== ARCHIVE_SHA256 || provenance.upstream.archiveExpectedSha256 !== ARCHIVE_SHA256) throw new Error('Provenance archive hash mismatch');
  const auditedFiles = [
    ['upstream-package.json', provenance.upstream.upstreamPackageJsonSha256],
    ['upstream-tsconfig.build.json', provenance.upstream.upstreamTsconfigBuildSha256],
    ['LICENSE', provenance.upstream.upstreamLicenseSha256],
    ['LICENSES/typebox-LICENSE', provenance.upstream.upstreamTypeboxLicenseSha256],
    ['tsconfig.build.json', provenance.compiler.configSha256],
  ];
  for (const [path, expected] of auditedFiles) {
    if (sha256File(join(PACKAGE, path)) !== expected) throw new Error(`Audited input hash does not match provenance: ${path}`);
  }
  if (sha256File(ARTIFACT) !== provenance.build.artifactSha256) throw new Error('Artifact hash does not match provenance');
  const source = sourceTree(join(PACKAGE, 'src'));
  if (source.sha256 !== provenance.upstream.sourceTreeSha256) throw new Error('Source tree hash does not match provenance');
  if (JSON.stringify(source.files) !== JSON.stringify(provenance.upstream.sourceFiles)) throw new Error('Source file inventory does not match provenance');
  if (artifactEntries().some((entry) => entry.includes('upstream-package') || entry.includes('tsconfig.build'))) throw new Error('Artifact contains audit-only source metadata');
  const manifest = readJson(join(PACKAGE, 'package.json'));
  if (JSON.stringify(manifest) !== JSON.stringify(PACKAGE_JSON)) throw new Error('Artifact source manifest does not match the pinned package definition');
  return provenance;
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--verify') {
    const provenance = verify();
    console.log(`verified ${provenance.package.name}@${provenance.package.version} ${provenance.build.artifactSha256}`);
    return;
  }
  if (mode !== '--rebuild') {
    console.error('Usage: node scripts/build-pi-schema.mjs --rebuild|--verify');
    process.exitCode = 2;
    return;
  }
  const archivePath = join(mkdtempSync(join(tmpdir(), 'apphx-pi-schema-')), 'upstream.tgz');
  try {
    await downloadArchive(archivePath);
    const upstreamPaths = copyPinnedSource(archivePath);
    const compiler = compilerVersion();
    buildPackage();
    const provenance = writeProvenance(archivePath, upstreamPaths, compiler);
    console.log(`built ${provenance.package.name}@${provenance.package.version} ${provenance.build.artifactSha256}`);
  } finally {
    rmSync(dirname(archivePath), { recursive: true, force: true });
  }
}

await main();
