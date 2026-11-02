import { MAX_HOST_PACKET_BYTES, previewText } from '../contracts/input-limits.js';
import type { DriveResult } from './runner.js';

// Reserve an auxiliary envelope before minting a host token. Diagnostics are
// previews; exact failures and notification packets remain in their read APIs.
const AUXILIARY_BYTES = 64 * 1024;
export const MAX_HOST_ACTION_BYTES = MAX_HOST_PACKET_BYTES - AUXILIARY_BYTES;
const MAX_ROWS = 64;

export function boundedDriveResult(input: DriveResult): DriveResult {
  const { failed, pendingErrors, intake, notifications, ...core } = input;
  const result: DriveResult = { ...core, ...(intake ? { intake: { accepted: intake.accepted } } : {}) };
  const omitted: NonNullable<DriveResult['omitted']> = {};
  if (result.action !== 'host' && Buffer.byteLength(JSON.stringify(result, null, 2)) > MAX_HOST_ACTION_BYTES) {
    const references: NonNullable<DriveResult['references']> = {};
    if (result.job) { references.job = result.job.id; omitted.job = 1; delete result.job; }
    if (result.result) { references.result = result.result.id; omitted.result = 1; delete result.result; }
    result.references = references;
  }
  // Leave room for field names, separators, counts and outer indentation. The
  // per-row estimate below deliberately overcounts indentation, never bytes.
  let remaining = Math.min(AUXILIARY_BYTES, MAX_HOST_PACKET_BYTES - Buffer.byteLength(JSON.stringify(result, null, 2))) - 2048;
  function rows<T>(values: readonly T[] | undefined, field: keyof typeof omitted, project: (value: T) => T): T[] {
    if (!values) return [];
    const output: T[] = [];
    for (const value of values) {
      if (output.length >= MAX_ROWS) break;
      const row = project(value);
      const encoded = JSON.stringify(row, null, 2);
      const cost = Buffer.byteLength(encoded) + 12 * (encoded.split('\n').length + 1);
      if (cost > remaining) break;
      remaining -= cost;
      output.push(row);
    }
    if (output.length < values.length) omitted[field] = values.length - output.length;
    return output;
  }
  const failedRows = rows(failed, 'failed', value => ({ ...value, error: value.error === null ? null : previewText(value.error, 2048) }));
  if (failedRows.length) result.failed = failedRows;
  const pendingRows = rows(pendingErrors, 'pendingErrors', value => ({ ...value, error: previewText(value.error, 2048) }));
  if (pendingRows.length) result.pendingErrors = pendingRows;
  const intakeRows = rows(intake?.errors, 'intakeErrors', value => ({ source: previewText(value.source, 1024), error: previewText(value.error, 2048) }));
  if (intakeRows.length) result.intake!.errors = intakeRows;
  // Do not shorten destinations, claims or receipts. A notification packet is
  // included whole or retrieved separately with apphx notify.
  const noticeRows = rows(notifications, 'notifications', value => value);
  if (noticeRows.length) result.notifications = noticeRows;
  if (Object.keys(omitted).length) result.omitted = omitted;
  const bytes = Buffer.byteLength(JSON.stringify(result, null, 2));
  if (bytes > MAX_HOST_PACKET_BYTES) throw new Error(`Drive response requires ${bytes} bytes, exceeding the ${MAX_HOST_PACKET_BYTES}-byte output limit`);
  return result;
}
