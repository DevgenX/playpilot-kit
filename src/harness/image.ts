import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

/**
 * Just enough PNG to give the harness perceptual frame hashes and point-sized frames without a native dependency:
 * decode 8-bit, non-interlaced grey/RGB/RGBA PNGs, box-resample, and encode RGBA PNGs.
 */

export interface Image {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  readonly data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

export class UnsupportedPng extends Error {
  override readonly name = "UnsupportedPng";
}

export function decodePng(buffer: Uint8Array): Image {
  const buf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new UnsupportedPng("not a PNG");
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("latin1", offset + 4, offset + 8);
    const body = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colorType = body[9] ?? -1;
      const interlace = body[12];
      if (depth !== 8 || interlace !== 0 || CHANNELS[colorType] === undefined) {
        throw new UnsupportedPng(`PNG depth ${depth}, colour type ${colorType}, interlace ${interlace} is not supported`);
      }
      channels = CHANNELS[colorType] ?? 0;
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0 || channels === 0) throw new UnsupportedPng("PNG has no image header");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new UnsupportedPng("PNG data is truncated");

  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x] ?? 0;
      const left = x >= channels ? (pixels[dst + x - channels] ?? 0) : 0;
      const up = y > 0 ? (pixels[dst - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= channels ? (pixels[dst - stride + x - channels] ?? 0) : 0;
      let predicted = 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          predicted = left;
          break;
        case 2:
          predicted = up;
          break;
        case 3:
          predicted = (left + up) >> 1;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default:
          throw new UnsupportedPng(`unknown PNG filter ${filter}`);
      }
      pixels[dst + x] = (value + predicted) & 0xff;
    }
  }

  if (channels === 4) return { width, height, data: pixels };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    const grey = channels <= 2;
    rgba[i * 4] = pixels[s] ?? 0;
    rgba[i * 4 + 1] = pixels[grey ? s : s + 1] ?? 0;
    rgba[i * 4 + 2] = pixels[grey ? s : s + 2] ?? 0;
    rgba[i * 4 + 3] = channels === 2 ? (pixels[s + 1] ?? 255) : 255;
  }
  return { width, height, data: rgba };
}

/** Area-average resample to an exact size (used to shrink retina screenshots to screen points). */
export function resize(image: Image, width: number, height: number): Image {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w === image.width && h === image.height) return image;
  const out = new Uint8Array(w * h * 4);
  const sx = image.width / w;
  const sy = image.height / h;
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1 && yy < image.height; yy += 1) {
        for (let xx = x0; xx < x1 && xx < image.width; xx += 1) {
          const i = (yy * image.width + xx) * 4;
          r += image.data[i] ?? 0;
          g += image.data[i + 1] ?? 0;
          b += image.data[i + 2] ?? 0;
          a += image.data[i + 3] ?? 0;
          n += 1;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, data: out };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(image: Image): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array())]);
}

function luma(image: Image, i: number): number {
  return 0.299 * (image.data[i] ?? 0) + 0.587 * (image.data[i + 1] ?? 0) + 0.114 * (image.data[i + 2] ?? 0);
}

export interface FrameFeatures {
  /** 64-bit difference hash as 16 hex chars: small changes (an idle animation, a clock) barely move it. */
  readonly hash: string;
  /** True when the frame is (nearly) one flat colour. */
  readonly blank: boolean;
  /** 32x32 greyscale thumbnail, base64: fine enough to see a dialog open, coarse enough to ignore idle motion. */
  readonly thumb: string;
}

/** dHash over a 9x8 greyscale thumbnail, plus a flat-frame check from the luma spread of a 32x32 thumbnail. */
export function frameFeatures(image: Image): FrameFeatures {
  const small = resize(image, 9, 8);
  let bits = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = luma(small, (y * 9 + x) * 4);
      const right = luma(small, (y * 9 + x + 1) * 4);
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  const thumb = resize(image, 32, 32);
  const grey = new Uint8Array(32 * 32);
  let min = 255;
  let max = 0;
  for (let i = 0; i < 32 * 32; i += 1) {
    const l = luma(thumb, i * 4);
    grey[i] = Math.round(l);
    if (l < min) min = l;
    if (l > max) max = l;
  }
  return { hash: bits.toString(16).padStart(16, "0"), blank: max - min < 6, thumb: Buffer.from(grey).toString("base64") };
}

/**
 * Share of thumbnail cells (0..1) whose brightness moved by more than a small step. An idle character moves a
 * few cells; a dialog, a new screen or a camera cut moves many.
 */
export function thumbChange(a: string, b: string): number {
  const x = Buffer.from(a, "base64");
  const y = Buffer.from(b, "base64");
  if (x.length !== y.length || x.length === 0) return 1;
  let changed = 0;
  for (let i = 0; i < x.length; i += 1) if (Math.abs((x[i] ?? 0) - (y[i] ?? 0)) > 24) changed += 1;
  return changed / x.length;
}

/** The frame changed in a way a player would notice (see thumbChange). */
export const VISIBLE_CHANGE = 0.03;

/** Number of differing bits between two hashes from frameFeatures (0 = same picture, 64 = opposite). */
export function hashDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

/** Fallback when a frame is not a PNG this module can read: exact-content hash, never blank. */
export function bytesFeatures(bytes: Uint8Array): FrameFeatures {
  const hash = createHash("sha256").update(bytes).digest("hex");
  return { hash: hash.slice(0, 16), blank: false, thumb: Buffer.from(hash, "hex").toString("base64") };
}
