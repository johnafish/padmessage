// Camera noise extraction.
//
// Image sensors add physical noise (photon shot noise, thermal noise) to
// every pixel. Most of it lives in the low bits and changes frame to frame.
// We turn it into uniform bytes in three conservative steps:
//
// 1. Estimate. For each chunk of pixels, take the low two bits of the
//    frame-to-frame difference of each pixel's green value, skipping clipped
//    values (pure black or white carry no noise). Only green is counted:
//    browsers receive camera frames as YUV 4:2:0, so R, G and B are mostly
//    derived from the same luma noise, and green tracks luma most closely.
//    Counting all three would credit the same noise three times. Estimate min-entropy with
//    the NIST SP 800-90B §6.3.1 most-common-value estimator. Differencing
//    against the previous frame removes static scene detail that would
//    otherwise look like randomness.
// 2. Discount. Credit only CREDIT_FACTOR of that estimate. The estimator
//    assumes independent samples; real frames are spatially correlated by
//    demosaicing, denoising and compression, so it overestimates.
// 3. Condition. Hash each chunk with Hash_df (SP 800-90A §10.3.1, a vetted
//    conditioning function in SP 800-90B), emitting at most
//    1/CONDITION_RATIO of the credited bits.
//
// Net, output is claimed at 1/8 of what an i.i.d. estimate suggests. Even so
// this cannot rule out a camera (or virtual camera) feeding predictable
// frames that merely look noisy, which is why the result is always XORed
// with the browser CSPRNG and never labelled true random.

export const CHUNK_PIXELS = 4096;
export const CREDIT_FACTOR = 0.25;
export const CONDITION_RATIO = 2;
/** Below this many usable samples, a chunk's estimate is too noisy to trust. */
const MIN_SYMBOLS = 1024;
/** Samples at or beyond these values are treated as clipped. */
const CLIP_LO = 1;
const CLIP_HI = 254;

const DOMAIN = new TextEncoder().encode('padmessage/camera/v1');

/** SP 800-90B §6.3.1 most-common-value min-entropy estimate, in bits per symbol. */
export function mcvMinEntropy(counts: ArrayLike<number>, n: number): number {
  if (n < 2) return 0;
  let max = 0;
  for (let i = 0; i < counts.length; i++) max = Math.max(max, counts[i]);
  const p = max / n;
  const pUpper = Math.min(1, p + 2.576 * Math.sqrt((p * (1 - p)) / (n - 1)));
  return Math.max(0, -Math.log2(pUpper)); // max() also turns -0 into 0
}

/** Usable 2-bit green-difference symbols in pixels [start, end) of two RGBA frames. */
export function differenceCounts(cur: ArrayLike<number>, prev: ArrayLike<number>, start: number, end: number) {
  const counts = new Uint32Array(4);
  let n = 0;
  for (let px = start; px < end; px++) {
    const a = cur[px * 4 + 1];
    const b = prev[px * 4 + 1];
    if (a <= CLIP_LO || a >= CLIP_HI || b <= CLIP_LO || b >= CLIP_HI) continue;
    counts[(a - b) & 3]++;
    n++;
  }
  return { counts, n };
}

/** Bits a chunk is credited with, after the discount. */
export function creditedBits(counts: ArrayLike<number>, n: number): number {
  if (n < MIN_SYMBOLS) return 0;
  return Math.floor(CREDIT_FACTOR * mcvMinEntropy(counts, n) * n);
}

/** Hash_df (SP 800-90A §10.3.1) with SHA-256: `blocks` × 32 bytes from `input`. */
async function hashDf(prefix: Uint8Array, input: Uint8Array, blocks: number): Promise<Uint8Array> {
  const out = new Uint8Array(blocks * 32);
  const buf = new Uint8Array(1 + 4 + prefix.length + input.length);
  new DataView(buf.buffer).setUint32(1, blocks * 256);
  buf.set(prefix, 5);
  buf.set(input, 5 + prefix.length);
  for (let i = 0; i < blocks; i++) {
    buf[0] = i + 1;
    out.set(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), i * 32);
  }
  buf.fill(0);
  return out;
}

export interface FrameYield {
  bytes: Uint8Array;
  /** Bits credited across the frame (before the conditioning ratio). */
  credited: number;
  /** Usable samples examined. */
  samples: number;
}

/**
 * Extracts uniform bytes from one RGBA frame, using the previous frame of
 * the same size to estimate its noise. `frameNo` keeps every hash input
 * distinct even if two frames happened to be identical.
 */
export async function conditionFrame(cur: Uint8Array | Uint8ClampedArray, prev: Uint8Array | Uint8ClampedArray, frameNo: number): Promise<FrameYield> {
  if (cur.length !== prev.length || cur.length % 4 !== 0) throw new Error('Frames must be RGBA and the same size.');
  const pixels = cur.length / 4;
  const parts: Uint8Array[] = [];
  let credited = 0;
  let samples = 0;
  for (let chunk = 0, start = 0; start < pixels; chunk++, start += CHUNK_PIXELS) {
    const end = Math.min(start + CHUNK_PIXELS, pixels);
    const { counts, n } = differenceCounts(cur, prev, start, end);
    const bits = creditedBits(counts, n);
    samples += n;
    credited += bits;
    const blocks = Math.min(255, Math.floor(bits / CONDITION_RATIO / 256));
    if (blocks === 0) continue;
    const prefix = new Uint8Array(DOMAIN.length + 8);
    prefix.set(DOMAIN, 0);
    const view = new DataView(prefix.buffer);
    view.setUint32(DOMAIN.length, frameNo);
    view.setUint32(DOMAIN.length + 4, chunk);
    parts.push(await hashDf(prefix, new Uint8Array(cur.buffer, cur.byteOffset + start * 4, (end - start) * 4), blocks));
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    bytes.set(p, off);
    off += p.length;
  }
  return { bytes, credited, samples };
}
