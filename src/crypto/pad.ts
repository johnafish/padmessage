// Pad files, identity, and sanity checks.
//
// A pad is a block of random bytes shared by exactly two people. It is split
// into two halves; side 0 ("Sun") only ever encrypts with the first half and
// side 1 ("Moon") only with the second, so the two parties can never consume
// the same bytes. Bytes within a half are consumed strictly forward.
//
// File format: either a raw blob of random bytes (side chosen by the user on
// import), or a 16-byte header followed by the pad body:
//   0..7   magic "PADMSG1\0"
//   8      side this copy is meant for (0 | 1)
//   9      randomness source: 1 browser CSPRNG, 2 hardware TRNG XOR CSPRNG,
//          3 camera noise XOR CSPRNG
//   10..15 reserved, zero
// The header is never part of the key material or the pad identity.

export type Side = 0 | 1;

export const SIDE_NAMES = ['Sun', 'Moon'] as const;

const MAGIC = new TextEncoder().encode('PADMSG1\0');
const HEADER_LEN = 16;

/**
 * Where a pad's bytes came from. Only true randomness gives the one-time
 * pad its unconditional guarantee; a CSPRNG pad is as strong as the
 * generator (excellent, but computational).
 *   csprng   - browser crypto.getRandomValues
 *   mixed    - hardware TRNG output XORed with the browser CSPRNG: at least
 *              as random as the better of the two
 *   webcam   - conditioned camera sensor noise XORed with the browser CSPRNG.
 *              Never weaker than csprng, but not claimed as true random: we
 *              can't verify how much real noise a given camera delivers
 *   external - a raw file from an unknown source; we can't vouch for it
 */
export type PadSource = 'csprng' | 'mixed' | 'webcam' | 'external';

const SOURCE_BYTES: Record<PadSource, number> = { external: 0, csprng: 1, mixed: 2, webcam: 3 };

export const MIN_PAD_BYTES = 64 * 1024;
export const MAX_PAD_BYTES = 512 * 1024 * 1024;

export interface ParsedPad {
  body: Uint8Array;
  side: Side | null;
  source: PadSource;
}

export function parsePadFile(bytes: Uint8Array): ParsedPad {
  const hasHeader = bytes.length > HEADER_LEN && MAGIC.every((b, i) => bytes[i] === b);
  if (!hasHeader) return { body: bytes, side: null, source: 'external' };
  const side = bytes[8];
  if (side !== 0 && side !== 1) throw new Error('Pad file header names an unknown side.');
  const source =
    (Object.keys(SOURCE_BYTES) as PadSource[]).find((k) => SOURCE_BYTES[k] === bytes[9]) ?? 'external';
  return { body: bytes.subarray(HEADER_LEN), side, source };
}

export function encodePadFile(body: Uint8Array, side: Side, source: PadSource): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + body.length);
  out.set(MAGIC, 0);
  out[8] = side;
  out[9] = SOURCE_BYTES[source];
  out.set(body, HEADER_LEN);
  return out;
}

/**
 * Fill a new pad from the platform CSPRNG (getRandomValues caps at 64 KiB per
 * call), optionally XORed with hardware TRNG output. XOR of independent
 * sources is at least as unpredictable as the better one, so a weak or
 * backdoored device can't make the pad worse than the browser alone.
 */
export function generatePad(size: number, hardware?: Uint8Array): Uint8Array {
  if (hardware && hardware.length < size) throw new Error('Hardware randomness is smaller than the pad.');
  const pad = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) {
    crypto.getRandomValues(pad.subarray(i, Math.min(i + 65536, size)));
  }
  if (hardware) for (let i = 0; i < size; i++) pad[i] ^= hardware[i];
  return pad;
}

/**
 * Remembers hardware dumps already spent, so one is never mixed into two
 * pads. Mixing always starts at byte 0, so any reuse of a file shares its
 * first 64 KiB whatever pad size was picked; hashing just that is enough.
 */
export async function entropyId(hardware: Uint8Array): Promise<string> {
  return base64url(await sha256(concat(ascii('padmessage/trng/v1'), hardware.subarray(0, 65536))));
}

/** Bytes available to each side. An odd trailing byte is never used. */
export function halfSize(padLength: number): number {
  return Math.floor(padLength / 2);
}

export interface PadIdentity {
  /** Server-visible chat id. A hash, so it reveals nothing about the pad bytes. */
  chatId: string;
  /** Human-comparable fingerprint, so both people can confirm they hold the same pad. */
  fingerprint: string;
  /**
   * Proves to the relay that a poster holds the pad. Only stops strangers who
   * know a chat link from spamming it; message integrity comes from the MAC.
   */
  writeKey: string;
}

export async function identifyPad(body: Uint8Array): Promise<PadIdentity> {
  const padHash = await sha256(body);
  const chatHash = await sha256(concat(ascii('padmessage/chat/v1'), padHash));
  const fpHash = await sha256(concat(ascii('padmessage/fp/v1'), padHash));
  const writeHash = await sha256(concat(ascii('padmessage/write/v1'), padHash));
  return {
    chatId: base64url(chatHash.subarray(0, 16)),
    fingerprint: formatFingerprint(fpHash),
    writeKey: base64url(writeHash),
  };
}

export function isChatId(s: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(s);
}

export interface RandomnessReport {
  ok: boolean;
  reason?: string;
}

/**
 * Catches obviously non-random input (text files, zeros, images) with a
 * byte-frequency chi-square test. Passing proves nothing: a good-looking pad
 * can still be predictable. Failing means it is definitely not a pad.
 */
export function checkRandomness(body: Uint8Array): RandomnessReport {
  if (body.length < MIN_PAD_BYTES) {
    return { ok: false, reason: `Pads must be at least ${MIN_PAD_BYTES / 1024} KB.` };
  }
  const counts = new Float64Array(256);
  for (let i = 0; i < body.length; i++) counts[body[i]]++;
  const expected = body.length / 256;
  let chi = 0;
  for (let i = 0; i < 256; i++) chi += (counts[i] - expected) ** 2 / expected;
  // df = 255; p ≈ 1e-6 at ~370. Real CSPRNG output sits near 255.
  if (chi > 370) {
    return { ok: false, reason: 'This file does not look random. It may be text, an image, or a weak generator.' };
  }
  return { ok: true };
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const FP_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

function formatFingerprint(hash: Uint8Array): string {
  // 80 bits as four groups of four base32 characters.
  let bits = 0n;
  for (let i = 0; i < 10; i++) bits = (bits << 8n) | BigInt(hash[i]);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += FP_ALPHABET[Number((bits >> BigInt(75 - i * 5)) & 31n)];
    if (i % 4 === 3 && i !== 15) out += '-';
  }
  return out;
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
