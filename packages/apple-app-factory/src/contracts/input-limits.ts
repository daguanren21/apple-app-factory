/** Shared byte ceiling for requirement, plan and completion JSON at CLI boundaries. */
export const MAX_INPUT_BYTES = 1024 * 1024;

/**
 * A host turn combines several independently bounded inputs: the immutable
 * requirement, current graph, dependency results and execution instructions.
 * Keep the emitted packet bounded while leaving room for those four inputs.
 */
export const MAX_HOST_PACKET_BYTES = 4 * MAX_INPUT_BYTES;

/** A readable transport preview; persisted values remain lossless. */
export function previewText(value: string, bytes: number): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  const suffix = '… [truncated; inspect persisted status]';
  const buffer = Buffer.from(value.slice(0, bytes));
  let end = Math.max(0, bytes - Buffer.byteLength(suffix));
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8') + suffix;
}

function minimumEvidenceBytes(requirements: readonly string[]): number {
  const distinct = new Set(requirements);
  let bytes = Math.max(0, distinct.size - 1);
  for (const requirement of distinct) bytes += Buffer.byteLength(JSON.stringify({ requirement, evidence: 'x' }));
  return bytes;
}

export function minimumReviewBytes(requirements: readonly string[]): number {
  return Buffer.byteLength('{"approved":true,"findings":[],"acceptanceEvidence":[]}') + minimumEvidenceBytes(requirements);
}

export function minimumNodeResultBytes(requirements: readonly string[], resultBytes?: number): number {
  const result = resultBytes === undefined ? 0 : Buffer.byteLength(',"result":') + resultBytes;
  return Buffer.byteLength('{"outcome":"passed","summary":"x","evidence":[]}') + minimumEvidenceBytes(requirements) + result;
}
