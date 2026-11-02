import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Minimal deterministic PNG engine for the obfuscator: decode owned PNGs to RGBA,
 * splice recolorable pixels back into the original chunk stream (ancillary chunks and
 * chunk order survive), and insert benign ancillary chunks to perturb file hashes.
 * Only 8-bit-per-sample, non-interlaced re-encodes are produced; decoding additionally
 * accepts 1/2/4/16-bit samples, palette (PLTE+tRNS) and gray(+alpha) source images.
 * Unsupported inputs (interlaced, truncated, foreign signatures) yield `undefined` so
 * callers can report them as unsupported instead of corrupting files.
 */

export interface PngImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  pixels: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngChunk {
  type: string;
  data: Buffer;
}

// CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320).
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let value = n;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Split a PNG byte stream into chunks without validating payload CRCs. */
function parseChunks(buffer: Buffer): PngChunk[] | undefined {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (offset + 12 + length > buffer.length) return undefined;
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return chunks;
}

function buildChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0);
  return Buffer.concat([header, data, crc]);
}

/** Paeth predictor, as specified for PNG filter type 4. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Undo scanline filters, returning the unfiltered sample bytes. */
function unfilter(raw: Buffer, width: number, height: number, channels: number, bitDepth: number): Buffer {
  const bitsPerPixel = channels * bitDepth;
  const bytesPerRow = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.floor(bitsPerPixel / 8));
  const out = Buffer.alloc(bytesPerRow * height);
  const previous = Buffer.alloc(bytesPerRow);
  let source = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[source]!;
    source += 1;
    if (filter > 4) return Buffer.alloc(0); // reserved filter: undecodable
    const row = raw.subarray(source, source + bytesPerRow);
    if (row.length !== bytesPerRow) return Buffer.alloc(0);
    source += bytesPerRow;
    const target = out.subarray(y * bytesPerRow, (y + 1) * bytesPerRow);
    for (let x = 0; x < bytesPerRow; x += 1) {
      const a = x >= bpp ? target[x - bpp]! : 0;
      const b = previous[x]!;
      const c = x >= bpp ? previous[x - bpp]! : 0;
      let value = row[x]!;
      if (filter === 1) value = (value + a) & 0xff;
      else if (filter === 2) value = (value + b) & 0xff;
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) value = (value + paeth(a, b, c)) & 0xff;
      target[x] = value;
    }
    previous.set(target);
  }
  return out;
}

/** Expand unfiltered samples into RGBA 8-bit pixels. Returns undefined for invalid input. */
function expand(
  raw: Buffer, width: number, height: number, bitDepth: number, colorType: number,
  palette: Buffer | undefined, transparent: Buffer | undefined,
): Uint8Array | undefined {
  const channels = CHANNELS[colorType];
  if (channels === undefined || (colorType === 3 && (!palette || palette.length % 3 !== 0))) return undefined;
  const bitsPerPixel = channels * bitDepth;
  const bytesPerRow = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < bytesPerRow * height) return undefined;
  const pixels = new Uint8Array(width * height * 4);
  const scale = bitDepth < 8 ? 255 / ((1 << bitDepth) - 1) : 1;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * bytesPerRow;
    for (let x = 0; x < width; x += 1) {
      const sampleAt = (sample: number): number => {
        if (bitDepth === 8) return raw[rowOffset + sample]!;
        if (bitDepth === 16) return raw[rowOffset + sample * 2]!; // high byte
        const bit = sample * bitDepth;
        const byte = raw[rowOffset + (bit >> 3)]!;
        return (byte >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
      };
      const sampleOffset = x * channels;
      const out = (y * width + x) * 4;
      let r = 0, g = 0, b = 0, a = 255;
      if (colorType === 0) {
        const gray = bitDepth === 16 ? sampleAt(sampleOffset) : Math.round(sampleAt(sampleOffset) * scale);
        r = g = b = gray;
        if (transparent && transparent.length >= 2 && transparent[0] === gray) a = 0;
      } else if (colorType === 2) {
        r = bitDepth === 16 ? sampleAt(sampleOffset) : Math.round(sampleAt(sampleOffset) * scale);
        g = bitDepth === 16 ? sampleAt(sampleOffset + 1) : Math.round(sampleAt(sampleOffset + 1) * scale);
        b = bitDepth === 16 ? sampleAt(sampleOffset + 2) : Math.round(sampleAt(sampleOffset + 2) * scale);
        if (transparent && transparent.length >= 6 && transparent[0] === r && transparent[2] === g && transparent[4] === b) a = 0;
      } else if (colorType === 3) {
        const index = sampleAt(sampleOffset);
        const entry = index * 3;
        if (!palette || entry + 2 >= palette.length) return undefined;
        r = palette[entry]!;
        g = palette[entry + 1]!;
        b = palette[entry + 2]!;
        if (transparent && index < transparent.length) a = transparent[index]!;
      } else if (colorType === 4) {
        const gray = bitDepth === 16 ? sampleAt(sampleOffset) : Math.round(sampleAt(sampleOffset) * scale);
        r = g = b = gray;
        a = bitDepth === 16 ? sampleAt(sampleOffset + 1) : Math.round(sampleAt(sampleOffset + 1) * scale);
      } else {
        r = bitDepth === 16 ? sampleAt(sampleOffset) : Math.round(sampleAt(sampleOffset) * scale);
        g = bitDepth === 16 ? sampleAt(sampleOffset + 1) : Math.round(sampleAt(sampleOffset + 1) * scale);
        b = bitDepth === 16 ? sampleAt(sampleOffset + 2) : Math.round(sampleAt(sampleOffset + 2) * scale);
        a = bitDepth === 16 ? sampleAt(sampleOffset + 3) : Math.round(sampleAt(sampleOffset + 3) * scale);
      }
      pixels[out] = r;
      pixels[out + 1] = g;
      pixels[out + 2] = b;
      pixels[out + 3] = a;
    }
  }
  return pixels;
}

/**
 * Decode an owned PNG into RGBA pixels. Returns undefined for non-PNG input,
 * interlaced images, reserved filters, truncated data or invalid palette references.
 */
export function parsePNG(buffer: Buffer): PngImage | undefined {
  const chunks = parseChunks(buffer);
  if (!chunks) return undefined;
  const ihdr = chunks.find(value => value.type === 'IHDR');
  if (!ihdr || ihdr.data.length !== 13) return undefined;
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8]!;
  const colorType = ihdr.data[9]!;
  if (ihdr.data[10] !== 0 || ihdr.data[11] !== 0) return undefined; // foreign compression/filter
  if (ihdr.data[12] !== 0) return undefined; // interlaced
  if (![1, 2, 4, 8, 16].includes(bitDepth) || !(colorType in CHANNELS)) return undefined;
  if (width === 0 || height === 0) return undefined;
  const palette = chunks.find(value => value.type === 'PLTE')?.data;
  const transparent = chunks.find(value => value.type === 'tRNS')?.data;
  const idat = Buffer.concat(chunks.filter(value => value.type === 'IDAT').map(value => value.data));
  if (idat.length === 0) return undefined;
  let raw: Buffer;
  try { raw = inflateSync(idat); } catch { return undefined; }
  const channels = CHANNELS[colorType]!;
  const expected = Math.ceil((width * channels * bitDepth) / 8) * height + height; // + filter byte per row
  if (raw.length < expected) return undefined;
  const samples = unfilter(raw, width, height, channels, bitDepth);
  if (samples.length === 0) return undefined;
  const pixels = expand(samples, width, height, bitDepth, colorType, palette, transparent);
  return pixels ? { width, height, pixels } : undefined;
}

/** Raw scanline stream for RGBA 8-bit pixels, filter type 0 (None) on every row. */
function buildRaw(image: PngImage): Buffer {
  const bytesPerRow = image.width * 4;
  const raw = Buffer.alloc((bytesPerRow + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (bytesPerRow + 1)] = 0;
    raw.set(image.pixels.subarray(y * bytesPerRow, (y + 1) * bytesPerRow), y * (bytesPerRow + 1) + 1);
  }
  return raw;
}

/**
 * Splice recolorable pixels back into an owned PNG: IHDR becomes 8-bit RGBA,
 * PLTE/tRNS are dropped, every IDAT chunk is replaced by one rebuilt IDAT, and all
 * other chunks (text, gamma, time, …) keep their original order. Returns undefined
 * when the input is not a parseable PNG.
 */
export function encodePNG(original: Buffer, image: PngImage): Buffer | undefined {
  const chunks = parseChunks(original);
  if (!chunks || !chunks.some(value => value.type === 'IHDR')) return undefined;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = deflateSync(buildRaw(image));
  const parts: Buffer[] = [PNG_SIGNATURE];
  let emitted = false;
  for (const { type, data } of chunks) {
    if (type === 'IEND' || type === 'PLTE' || type === 'tRNS') continue;
    if (type === 'IHDR') { parts.push(buildChunk('IHDR', ihdr)); continue; }
    if (type === 'IDAT') {
      if (!emitted) { parts.push(buildChunk('IDAT', idat)); emitted = true; }
      continue;
    }
    parts.push(buildChunk(type, data));
  }
  if (!emitted) parts.push(buildChunk('IDAT', idat));
  parts.push(buildChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** Build a fresh minimal 8-bit RGBA PNG (used by fixtures and standalone tests). */
export function buildPNG(image: PngImage): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = deflateSync(buildRaw(image));
  return Buffer.concat([
    PNG_SIGNATURE, buildChunk('IHDR', ihdr), buildChunk('IDAT', idat), buildChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Insert an ancillary chunk directly after IHDR. PNG decoders ignore unknown ancillary
 * chunk types, so a tEXt-style chunk changes the file hash without touching pixels.
 * Returns undefined when the input is not a parseable PNG.
 */
export function insertPngChunk(buffer: Buffer, type: string, data: Buffer): Buffer | undefined {
  const chunks = parseChunks(buffer);
  if (!chunks) return undefined;
  const ihdrIndex = chunks.findIndex(value => value.type === 'IHDR');
  if (ihdrIndex === -1) return undefined;
  const parts: Buffer[] = [PNG_SIGNATURE];
  chunks.forEach((value, index) => {
    parts.push(buildChunk(value.type, value.data));
    if (index === ihdrIndex) parts.push(buildChunk(type, data));
  });
  return Buffer.concat(parts);
}
