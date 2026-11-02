import { arr, int, obj, oneOf, str, type Static } from '@earendil-works/pi-schema';
import { defineContract, nonblankText, type Parsed } from './validation.js';

export const UI_QUALITY_CHECKS = ['system-insets', 'responsive-layout', 'keyboard-focus', 'text-scaling', 'motion', 'visual-design'] as const;
export type UiQualityCheckId = typeof UI_QUALITY_CHECKS[number];

export const CapturePathSchema = defineContract(nonblankText(), { check(value, issue) {
  if (/[\\:*?"<>|\[\]{}\x00-\x1f\x7f]/.test(value)
    || !value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    issue([], 'Expected an exact portable project-relative path without traversal, absolute paths or globs');
  }
} });
const digest = defineContract(str({ pattern: '^[a-fA-F0-9]{64}$' }), { normalize: value => value.toLowerCase() });
const capture = obj({
  path: CapturePathSchema.schema,
  sha256: digest.schema,
  kind: oneOf(['image', 'video', 'trace']),
  viewport: obj({ width: int({ minimum: 1, maximum: 16384 }), height: int({ minimum: 1, maximum: 16384 }) }),
  device: nonblankText(300),
  state: nonblankText(2000),
});
const check = obj({
  id: oneOf(UI_QUALITY_CHECKS),
  status: oneOf(['passed', 'failed', 'not-applicable']),
  observation: nonblankText(10000),
  capturePaths: arr(CapturePathSchema.schema, { maxItems: 32 }),
});

/** Specialists may supply partial coverage; final approval requires all six checks. */
export const UiQualitySchema = defineContract(obj({
  captures: arr(capture, { maxItems: 32 }),
  checks: arr(check, { maxItems: 6 }),
}), { check(value, issue) {
  const paths = new Set<string>(), ids = new Set<UiQualityCheckId>();
  for (const [index, entry] of value.captures.entries()) {
    if (paths.has(entry.path)) issue(['captures', index, 'path'], 'Duplicate UI capture path');
    paths.add(entry.path);
  }
  for (const [index, entry] of value.checks.entries()) {
    if (ids.has(entry.id)) issue(['checks', index, 'id'], 'Duplicate UI quality check ID');
    ids.add(entry.id);
  }
} });
export type UiQuality = Parsed<typeof UiQualitySchema>;
export type UiCapture = Static<typeof capture>;
export type UiQualityCheck = Static<typeof check>;

/** Lower bound on compact review JSON overhead, not a reservation or sufficient proof. */
export function minimumUiQualityBytes(screenshotsDir: string): number {
  const directory = CapturePathSchema.parse(screenshotsDir);
  const paths = [`${directory}/a.png`, `${directory}/b.png`];
  const captures: UiCapture[] = paths.map((path, index) => ({
    path, sha256: '0'.repeat(64), kind: 'image', viewport: { width: 1, height: index + 1 }, device: 'x', state: 'x',
  }));
  const checks: UiQualityCheck[] = UI_QUALITY_CHECKS.map(id => ({
    id, status: id === 'motion' ? 'not-applicable' : 'passed', observation: 'x',
    capturePaths: id === 'responsive-layout' ? paths : [paths[0]!],
  }));
  // Real observed descriptions are longer. Keyboard passed is shorter than N/A;
  // motion N/A avoids inventing a mandatory third (video/trace) capture.
  return Buffer.byteLength(',"uiQuality":') + Buffer.byteLength(JSON.stringify({ captures, checks }));
}
