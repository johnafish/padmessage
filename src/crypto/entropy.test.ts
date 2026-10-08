import { describe, expect, it } from 'vitest';
import { CONDITION_RATIO, CREDIT_FACTOR, conditionFrame, mcvMinEntropy } from './entropy.ts';
import { generatePad } from './pad.ts';

const W = 320;
const H = 240;

/** An RGBA frame from a per-sample function. */
function frame(fn: (i: number) => number): Uint8Array {
  const f = new Uint8Array(W * H * 4);
  for (let i = 0; i < f.length; i++) f[i] = i % 4 === 3 ? 255 : fn(i);
  return f;
}

/** A mid-grey scene plus `noise` levels of fresh random noise per sample. */
function noisy(noise: number): Uint8Array {
  const r = generatePad(W * H * 4);
  return frame((i) => 100 + (i % 50) + (r[i] % (noise + 1)));
}

describe('mcvMinEntropy', () => {
  it('is near the symbol width for uniform symbols and zero for a constant', () => {
    expect(mcvMinEntropy([25000, 25000, 25000, 25000], 100000)).toBeGreaterThan(1.95);
    expect(mcvMinEntropy([100000, 0, 0, 0], 100000)).toBe(0);
  });

  it('applies the 99% upper bound, so small samples get less credit', () => {
    expect(mcvMinEntropy([25, 25, 25, 25], 100)).toBeLessThan(mcvMinEntropy([2500, 2500, 2500, 2500], 10000));
  });
});

describe('conditionFrame', () => {
  it('yields nothing from identical (frozen) frames', async () => {
    const f = noisy(8);
    const y = await conditionFrame(f, f, 1);
    expect(y.bytes.length).toBe(0);
    expect(y.credited).toBe(0);
  });

  it('yields nothing from clipped (blown-out or black) frames', async () => {
    const white = frame(() => 255);
    const black = frame(() => 0);
    expect((await conditionFrame(white, black, 1)).bytes.length).toBe(0);
  });

  it('extracts from noisy frames, never emitting more than the conditioning bound', async () => {
    const y = await conditionFrame(noisy(16), noisy(16), 1);
    expect(y.bytes.length).toBeGreaterThan(0);
    expect(y.bytes.length * 8).toBeLessThanOrEqual(y.credited / CONDITION_RATIO);
    // Credited is itself a fraction of the raw i.i.d. estimate (≤ 2 bits/sample).
    expect(y.credited).toBeLessThanOrEqual(CREDIT_FACTOR * 2 * y.samples);
  });

  it('credits more for more noise', async () => {
    const low = await conditionFrame(noisy(1), noisy(1), 1);
    const high = await conditionFrame(noisy(16), noisy(16), 1);
    expect(high.credited).toBeGreaterThan(low.credited);
  });

  it('gives little credit to a predictable pattern that changes in a structured way', async () => {
    // A scene that shifts by a constant each frame: every difference is the same.
    const a = frame((i) => 60 + ((i >> 2) % 120));
    const b = frame((i) => 61 + ((i >> 2) % 120));
    expect((await conditionFrame(b, a, 1)).bytes.length).toBe(0);
  });

  it('is deterministic for the same input and separates frames by number', async () => {
    const [cur, prev] = [noisy(16), noisy(16)];
    const one = await conditionFrame(cur, prev, 7);
    expect((await conditionFrame(cur, prev, 7)).bytes).toEqual(one.bytes);
    expect((await conditionFrame(cur, prev, 8)).bytes).not.toEqual(one.bytes);
  });

  it('produces output that passes a byte-frequency sanity check', async () => {
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < 12; i++) chunks.push((await conditionFrame(noisy(16), noisy(16), i)).bytes);
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) all.set(c, (o += c.length) - c.length);
    const counts = new Float64Array(256);
    for (const b of all) counts[b]++;
    const e = all.length / 256;
    const chi = counts.reduce((s, c) => s + (c - e) ** 2 / e, 0);
    expect(all.length).toBeGreaterThan(16000);
    expect(chi).toBeLessThan(370);
  });
});
