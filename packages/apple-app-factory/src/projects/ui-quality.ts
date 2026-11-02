import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalPath, inside } from '../configuration/config.js';
import type { Job } from '../contracts/schemas.js';
import { CapturePathSchema, UI_QUALITY_CHECKS, UiQualitySchema, type UiCapture, type UiQuality, type UiQualityCheck, type UiQualityCheckId } from '../contracts/ui-quality.js';
import { generatedModulePaths, isGeneratedPath } from './dependencies.js';
import { artifactOutputPath, projectDirectory } from './workspace.js';

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const uiGuide = fileURLToPath(new URL('../../skills/apphx/resources/ui-design-guide.md', import.meta.url));
const platformGuide = fileURLToPath(new URL('../../skills/apphx/resources/platform-ui.md', import.meta.url));

export function uiQualityInstructions(job: Pick<Job, 'spec' | 'config'>): string {
  const { spec } = job;
  const stack: Record<Job['spec']['framework'], string> = {
    flutter: 'Use Flutter SafeArea and MediaQuery viewPadding/viewInsets; observe keyboard resizing and large text on the native surface.',
    'android-java': 'Use Android WindowInsets for edge-to-edge, display cutouts, system bars and IME; verify gesture navigation and font scaling.',
    swift: 'Use UIKit safeAreaLayoutGuide or SwiftUI safe-area APIs and keyboard behavior; verify Dynamic Type and home-indicator clearance.',
    'react-native': 'Use the existing React Native safe-area-context and keyboard handling; verify native insets and font scaling rather than fixed padding.',
    expo: 'Use the existing Expo/React Native safe-area-context and keyboard handling; verify native insets, system bars and font scaling.',
    'uni-app': 'Respect native shell insets and IME; for webviews use CSS env(safe-area-inset-*), dynamic viewport units and visual viewport behavior where applicable.',
    mygo: 'Verify the real MyGo macOS window and webview: title bar/traffic lights, resize/minimum size, high DPI, keyboard focus/shortcuts, dialogs and scrolling.',
  };
  const design = spec.designRef
    ? `Use the actual Figma/design reference ${spec.designRef} and existing project tokens/components as visual authority. If the reference is inaccessible, report the missing source; do not claim reproduction.`
    : 'No Figma reference: inspect and reuse the existing project design/tokens/components first. Only a greenfield app chooses a coherent, product-specific direction; avoid generic gradients/cards or a competing design system.';
  const platform = spec.platform === 'macos'
    ? 'Desktop: exercise native chrome/title-bar clearance, minimum and wide window sizes, high DPI/text scale, pointer and keyboard focus/shortcuts, scrolling and dialogs; do not merely enlarge a phone layout.'
    : 'Mobile: exercise status/navigation bars, display cutout and home-indicator/gesture insets, keyboard/IME, small/narrow/tall viewports and supported orientations, large system text, scrolling and reachable tap targets. Never hard-code status-bar pixel padding.';
  const guidance = [
    `Read the apphx UI handoff and platform evidence guides: ${uiGuide} and ${platformGuide}. Discover specialist skills through the host for the actual task; these local guides do not bundle or activate an external design skill.`,
    design, platform, stack[spec.framework],
    'Motion: use purposeful feedback/continuity, interruptible/reversible transitions and reduced-motion behavior; preserve focus and never depend on animation-end for correctness. Observe the running app or record it; screenshots alone cannot prove motion and no unmeasured 60fps claim is permitted.',
  ];
  if (job.config.uiQuality !== true) return guidance.join('\n');
  return [
    ...guidance,
    'UI quality is required for approved completion; do not disable the owner-configured gate to pass.',
    `Before runtime verification finishes, save real captures inside ${spec.screenshotsDir ?? 'the owner-configured generated screenshotsDir'}, relative to the selected project. Review cannot introduce or change captures after the frozen screenshot proof. Hash the actual bytes with SHA-256; use exact project-relative paths, never absolute paths, globs, traversal or symlinks.`,
    'Return review.uiQuality with this JSON shape (descriptors are not evidence): {"captures":[{"path":"project-relative capture file","sha256":"actual 64hex byte digest","kind":"image|video|trace","viewport":{"width":390,"height":844},"device":"observed device/window and scale","state":"observed UI state/settings"}],"checks":[{"id":"check ID","status":"passed|failed|not-applicable","observation":"concrete observed result or observed reason for non-applicability","capturePaths":["matching captures[].path"]}]}.',
    `All six check IDs are required at final approval: ${UI_QUALITY_CHECKS.join(', ')}. Specialists may contribute partial coverage; any failed specialist check remains a veto.`,
    'Every passed check must reference captures: system-insets and visual-design need PNG/JPEG images; responsive-layout needs images at two genuinely different viewport geometries; text-scaling needs image/trace; keyboard-focus needs image/video/trace; motion needs video/trace, never only screenshots. Image viewport dimensions must equal encoded image pixel dimensions; record logical dimensions and display scale in device/state where relevant. Dimensions alone do not establish responsive coverage. Videos may be MP4/WebM; traces JSON/TXT, nonempty. Each capture is at most 64 MiB, with at most 32 captures and six unique checks.',
    'Only keyboard-focus and motion may be not-applicable, with a concrete observed reason and referenced capture evidence for independent review, not missing tools or unperformed checks. This structural gate does not prove beauty, motion quality or framerate; independent native visual review and the separate acceptanceEvidence remain required. Negative verdicts should report repair findings, not fabricate positive proof.',
  ].join('\n');
}

function screenshotRoot(job: Job): { project: string; screenshots: string } {
  const directory = CapturePathSchema.parse(job.spec.screenshotsDir);
  if (canonicalPath(job.workspace) !== resolve(job.workspace) || !lstatSync(job.workspace).isDirectory()) throw new Error('UI evidence workspace and its ancestors must be real directories without symlinks');
  const project = projectDirectory(job);
  if (canonicalPath(project) !== project || !lstatSync(project).isDirectory()) throw new Error('UI evidence project and its ancestors must be real directories without symlinks');
  const screenshots = artifactOutputPath(project, directory);
  const workspacePath = relative(job.workspace, screenshots).split(sep).join('/');
  const generated = isGeneratedPath(directory, job.spec.framework)
    || [...generatedModulePaths(job.workspace, job.spec.framework, job.spec.project?.directory)].some(output => workspacePath.startsWith(`${output}/`));
  if (!generated || !/(?:^|\/)(?:build|dist|unpackage)(?:\/|$)/.test(directory)
    || /(?:^|\/)(?:node_modules|\.git|\.gradle|\.factory-cache|\.factory-input|\.dart_tool|\.idea|\.expo|\.yarn|\.mygo|Pods)(?:\/|$)/.test(directory)) {
    throw new Error('UI screenshotsDir must be inside generated build/dist/unpackage output, never source, control metadata or dependency caches');
  }
  if (!lstatSync(screenshots).isDirectory()) throw new Error('UI screenshotsDir must be a real directory');
  return { project, screenshots };
}

/** Bound allocation and read a regular, non-symlink file through its checked descriptor. */
function captureBytes(project: string, screenshots: string, capture: UiCapture): Buffer {
  const path = artifactOutputPath(project, capture.path);
  inside(screenshots, path);
  const entry = lstatSync(path);
  if (!entry.isFile()) throw new Error(`UI capture must be a regular file: ${capture.path}`);
  if (entry.size === 0 || entry.size > MAX_CAPTURE_BYTES) throw new Error(`UI capture must be nonempty and at most 64 MiB: ${capture.path}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino || before.size !== entry.size) throw new Error(`UI capture changed while opening: ${capture.path}`);
    const buffer = Buffer.allocUnsafe(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    artifactOutputPath(project, capture.path);
    const current = lstatSync(path);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== after.size
      || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) throw new Error(`UI capture changed while reading: ${capture.path}`);
    const bytes = buffer.subarray(0, length);
    if (createHash('sha256').update(bytes).digest('hex') !== capture.sha256) throw new Error(`UI capture SHA-256 mismatch: ${capture.path}`);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function pngDimensions(bytes: Buffer): UiCapture['viewport'] {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Invalid PNG image header');
  const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!depths[bytes[25]!]?.includes(bytes[24]!) || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28]! > 1) throw new Error('Invalid PNG image format');
  let offset = 33, imageData = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (size > bytes.length - offset - 12 || !/^[A-Za-z]{4}$/.test(type) || type === 'IHDR') throw new Error('Invalid or truncated PNG image chunk');
    if (type === 'IDAT' && size > 0) imageData = true;
    offset += size + 12;
    if (type === 'IEND') {
      if (size !== 0 || offset !== bytes.length || !imageData) throw new Error('Invalid PNG image data');
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
  }
  throw new Error('Truncated PNG image');
}

function jpegDimensions(bytes: Buffer): UiCapture['viewport'] {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new Error('Invalid JPEG image header or end marker');
  let offset = 2, dimensions: UiCapture['viewport'] | undefined;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) throw new Error('Invalid JPEG image marker');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd9 || offset + 2 > bytes.length) throw new Error('Invalid JPEG image segment');
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length - 2) throw new Error('Truncated JPEG image segment');
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (dimensions || size < 11 || ![8, 12, 16].includes(bytes[offset + 2]!) || size !== 8 + 3 * bytes[offset + 7]!) throw new Error('Invalid JPEG image frame');
      dimensions = { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    if (marker === 0xda) {
      if (!dimensions || size < 6 || size !== 6 + 2 * bytes[offset + 2]! || offset + size >= bytes.length - 2) throw new Error('Invalid JPEG image scan');
      return dimensions;
    }
    offset += size;
  }
  throw new Error('JPEG image is missing a frame or scan');
}

/** Container checks bind the declaration to bytes, not a claim to have decoded or watched them. */
function validateCaptureType(capture: UiCapture, bytes: Buffer): void {
  const extension = extname(capture.path).toLowerCase();
  if (capture.kind === 'image') {
    const dimensions = extension === '.png' ? pngDimensions(bytes)
      : extension === '.jpg' || extension === '.jpeg' ? jpegDimensions(bytes) : undefined;
    if (!dimensions) throw new Error(`UI image must be PNG or JPEG: ${capture.path}`);
    if (dimensions.width !== capture.viewport.width || dimensions.height !== capture.viewport.height) throw new Error(`UI image dimensions do not match the declared viewport: ${capture.path}`);
  } else if (capture.kind === 'video') {
    const mp4 = extension === '.mp4' && bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp' && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length;
    const webm = extension === '.webm' && bytes.length > 4 && bytes.readUInt32BE(0) === 0x1a45dfa3;
    if (!mp4 && !webm) throw new Error(`UI video must have an MP4 or WebM container header: ${capture.path}`);
  } else {
    if (!['.json', '.txt'].includes(extension)) throw new Error(`UI trace must be JSON or TXT: ${capture.path}`);
    if (!new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()) throw new Error(`UI trace must contain observed evidence: ${capture.path}`);
  }
}

export function validateUiQuality(job: Job, evidence: unknown): UiQuality {
  const quality = UiQualitySchema.parse(evidence);
  const checks = new Map(quality.checks.map(check => [check.id, check]));
  for (const id of UI_QUALITY_CHECKS) {
    const check = checks.get(id);
    if (!check) throw new Error(`UI quality is missing required check: ${id}`);
    if (check.status === 'failed') throw new Error(`UI quality check failed: ${id}: ${check.observation}`);
    if (check.status === 'not-applicable' && id !== 'keyboard-focus' && id !== 'motion') throw new Error(`UI quality check cannot be not-applicable: ${id}`);
    if (!check.capturePaths.length) throw new Error(`UI quality ${id} requires referenced captures, including an observed reason when not-applicable`);
  }
  const { project, screenshots } = screenshotRoot(job);
  const captures = new Map<string, UiCapture>();
  for (const capture of quality.captures) {
    validateCaptureType(capture, captureBytes(project, screenshots, capture));
    captures.set(capture.path, capture);
  }
  for (const check of quality.checks) {
    const referenced = check.capturePaths.map(path => {
      const capture = captures.get(path);
      if (!capture) throw new Error(`UI quality ${check.id} references an unknown capture: ${path}`);
      return capture;
    });
    // Applicability and the truth of observed reasons belong to independent review,
    // not English keyword matching or a minimum word-count pretending to prove them.
    if (check.status === 'not-applicable') continue;
    const has = (...kinds: UiCapture['kind'][]): boolean => referenced.some(capture => kinds.includes(capture.kind));
    if ((check.id === 'system-insets' || check.id === 'visual-design') && !has('image')) throw new Error(`UI quality ${check.id} requires an image capture`);
    if (check.id === 'text-scaling' && !has('image', 'trace')) throw new Error('UI quality text-scaling requires image or trace evidence');
    if (check.id === 'motion' && !has('video', 'trace')) throw new Error('UI quality motion requires video or trace evidence, not screenshots alone');
    if (check.id === 'responsive-layout') {
      const geometries = new Set(referenced.filter(capture => capture.kind === 'image').map(capture => `${capture.viewport.width}x${capture.viewport.height}`));
      if (geometries.size < 2) throw new Error('UI quality responsive-layout requires images at two distinct viewport geometries');
    }
  }
  return quality;
}

export function combineUiQuality(evidences: readonly unknown[]): UiQuality | undefined {
  const captures = new Map<string, UiCapture>(), checks = new Map<UiQualityCheckId, UiQualityCheck[]>();
  for (const evidence of evidences) {
    if (evidence === undefined || evidence === null) continue;
    const quality = UiQualitySchema.parse(evidence);
    for (const capture of quality.captures) {
      const previous = captures.get(capture.path);
      if (previous && (previous.sha256 !== capture.sha256 || previous.kind !== capture.kind
        || previous.viewport.width !== capture.viewport.width || previous.viewport.height !== capture.viewport.height
        || previous.device !== capture.device || previous.state !== capture.state)) throw new Error(`Conflicting UI capture identity: ${capture.path}`);
      if (!previous) captures.set(capture.path, capture);
    }
    for (const check of quality.checks) {
      const entries = checks.get(check.id);
      if (entries) entries.push(check);
      else checks.set(check.id, [check]);
    }
  }
  if (!captures.size && !checks.size) return undefined;
  const merged: UiQualityCheck[] = [];
  for (const id of UI_QUALITY_CHECKS) {
    const entries = checks.get(id);
    if (!entries) continue;
    const statuses = new Set(entries.map(entry => entry.status));
    const failed = statuses.has('failed');
    if (!failed && statuses.size > 1) throw new Error(`Conflicting UI quality applicability: ${id}`);
    merged.push({
      id, status: failed ? 'failed' : entries[0]!.status,
      observation: [...new Set(entries.map(entry => statuses.size > 1 ? `[${entry.status}] ${entry.observation}` : entry.observation))].join('\n'),
      capturePaths: [...new Set(entries.flatMap(entry => entry.capturePaths))],
    });
  }
  // Reject overflow rather than silently dropping observations, captures or failed vetoes.
  return UiQualitySchema.parse({ captures: [...captures.values()], checks: merged });
}
