import { z } from 'zod';

export const UI_QUALITY_CHECKS = ['system-insets', 'responsive-layout', 'keyboard-focus', 'text-scaling', 'motion', 'visual-design'] as const;
export type UiQualityCheckId = typeof UI_QUALITY_CHECKS[number];

const text = z.string().min(1).refine(value => value.trim().length > 0 && !value.includes('\0'), 'Expected nonblank text without NUL characters');
const capturePath = text.refine(value => !/[\\:*?"<>|\[\]{}\x00-\x1f\x7f]/.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
'Expected an exact portable project-relative path without traversal, absolute paths or globs');
const capture = z.strictObject({
  path: capturePath,
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).transform(value => value.toLowerCase()),
  kind: z.enum(['image', 'video', 'trace']),
  viewport: z.strictObject({ width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384) }),
  device: text.max(300),
  state: text.max(2000),
});
const check = z.strictObject({
  id: z.enum(UI_QUALITY_CHECKS),
  status: z.enum(['passed', 'failed', 'not-applicable']),
  observation: text.max(10000),
  capturePaths: z.array(capturePath).max(32),
});

/** Specialists may supply partial coverage; final approval requires all six checks. */
export const UiQualitySchema = z.strictObject({
  captures: z.array(capture).max(32),
  checks: z.array(check).max(6),
}).superRefine((value, context) => {
  const paths = new Set<string>(), ids = new Set<UiQualityCheckId>();
  for (const [index, entry] of value.captures.entries()) {
    if (paths.has(entry.path)) context.addIssue({ code: 'custom', path: ['captures', index, 'path'], message: 'Duplicate UI capture path' });
    paths.add(entry.path);
  }
  for (const [index, entry] of value.checks.entries()) {
    if (ids.has(entry.id)) context.addIssue({ code: 'custom', path: ['checks', index, 'id'], message: 'Duplicate UI quality check ID' });
    ids.add(entry.id);
  }
});
export type UiQuality = z.infer<typeof UiQualitySchema>;
export type UiCapture = z.infer<typeof capture>;
export type UiQualityCheck = z.infer<typeof check>;

/** Lower bound on compact review JSON overhead, not a reservation or sufficient proof. */
export function minimumUiQualityBytes(screenshotsDir: string): number {
  const directory = capturePath.parse(screenshotsDir);
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
