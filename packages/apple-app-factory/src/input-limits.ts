/** Shared byte ceiling for requirement, plan and completion JSON at CLI boundaries. */
export const MAX_INPUT_BYTES = 1024 * 1024;

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
