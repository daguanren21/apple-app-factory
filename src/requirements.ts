import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { RequirementSchema, type Spec } from './schemas.js';

export const MAX_INPUT_BYTES = 1024 * 1024;
export type Requirement = { spec: Spec; baseJobId?: string };

export function parseRequirement(value: unknown): Requirement {
  const { baseJobId, ...spec } = RequirementSchema.parse(value);
  return { spec, ...(baseJobId === undefined ? {} : { baseJobId }) };
}

export function readInputFile(path: string, label = 'Requirement'): Buffer {
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`${label} ${path} is a symbolic link; provide a regular file`);
  if (!info.isFile()) throw new Error(`${label} ${path} is not a regular file; provide a regular file`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`${label} ${path} is not a regular file; provide a regular file`);
    if (opened.size > MAX_INPUT_BYTES) throw new Error(`${label} ${path} exceeds ${MAX_INPUT_BYTES} bytes; reduce its size`);
    const bytes = Buffer.allocUnsafe(opened.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_INPUT_BYTES) throw new Error(`${label} ${path} exceeds ${MAX_INPUT_BYTES} bytes; reduce its size`);
    if (size > opened.size) throw new Error(`${label} ${path} changed while being read; retry after writing is complete`);
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
