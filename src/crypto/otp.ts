// One-time-pad message sealing.
//
// Each message consumes a fresh, contiguous run of pad bytes from the
// sender's half:
//   [ 32 bytes Poly1305 one-time key | N bytes keystream ]
// The framed plaintext (N bytes) is XORed with the keystream, then the
// header + ciphertext is authenticated with Poly1305 under the one-time key
// (encrypt-then-MAC). With a truly random pad and no reuse, secrecy is
// information-theoretic and forgery succeeds with probability ~2^-100 per
// attempt regardless of the attacker's compute.

import { poly1305 } from '@noble/ciphers/_poly1305.js';
import { equalBytes } from '@noble/ciphers/utils.js';
import { halfSize, type Side } from './pad.ts';

export const MAC_KEY_BYTES = 32;
export const TAG_BYTES = 16;
/** Plaintext is padded to a multiple of this to blur exact message lengths. */
export const BLOCK = 32;
export const MAX_TEXT_CHARS = 4000;

const VERSION = 1;
const KIND_TEXT = 1;
// version u8 | kind u8 | sentAt f64 | textLen u32
const FRAME_HEADER = 14;

export interface Sealed {
  side: Side;
  offset: number;
  ct: Uint8Array;
  tag: Uint8Array;
}

export interface OpenedText {
  text: string;
  sentAt: number;
}

/** Pad bytes a message of this text will consume. */
export function costOf(text: string): number {
  return MAC_KEY_BYTES + framedLength(new TextEncoder().encode(text).length);
}

export function costOfCiphertext(ctLength: number): number {
  return MAC_KEY_BYTES + ctLength;
}

function framedLength(textBytes: number): number {
  return Math.ceil((FRAME_HEADER + textBytes) / BLOCK) * BLOCK;
}

export function frameText(text: string, sentAt: number): Uint8Array {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(framedLength(body.length));
  const view = new DataView(out.buffer);
  out[0] = VERSION;
  out[1] = KIND_TEXT;
  view.setFloat64(2, sentAt);
  view.setUint32(10, body.length);
  out.set(body, FRAME_HEADER);
  return out;
}

export function unframeText(framed: Uint8Array): OpenedText {
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  if (framed.length < FRAME_HEADER || framed[0] !== VERSION || framed[1] !== KIND_TEXT) {
    throw new Error('Unknown message format.');
  }
  const len = view.getUint32(10);
  if (FRAME_HEADER + len > framed.length) throw new Error('Corrupt message frame.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(framed.subarray(FRAME_HEADER, FRAME_HEADER + len));
  return { text, sentAt: view.getFloat64(2) };
}

/** Absolute pad range for a message, or an error if it escapes the side's half. */
function padRange(pad: Uint8Array, side: Side, offset: number, ctLength: number): [number, number] {
  const half = halfSize(pad.length);
  const cost = costOfCiphertext(ctLength);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + cost > half) {
    throw new Error('Message falls outside the pad.');
  }
  const start = side * half + offset;
  return [start, start + cost];
}

function authData(chatId: string, side: Side, offset: number, ct: Uint8Array): Uint8Array {
  const id = new TextEncoder().encode(chatId);
  const out = new Uint8Array(1 + id.length + 1 + 8 + 4 + ct.length);
  const view = new DataView(out.buffer);
  let p = 0;
  out[p++] = id.length;
  out.set(id, p);
  p += id.length;
  out[p++] = side;
  view.setFloat64(p, offset); // exact for any safe integer
  p += 8;
  view.setUint32(p, ct.length);
  p += 4;
  out.set(ct, p);
  return out;
}

export function seal(pad: Uint8Array, chatId: string, side: Side, offset: number, framed: Uint8Array): Sealed {
  const [start] = padRange(pad, side, offset, framed.length);
  const macKey = pad.subarray(start, start + MAC_KEY_BYTES);
  const stream = pad.subarray(start + MAC_KEY_BYTES, start + MAC_KEY_BYTES + framed.length);
  const ct = new Uint8Array(framed.length);
  for (let i = 0; i < ct.length; i++) ct[i] = framed[i] ^ stream[i];
  const tag = poly1305(authData(chatId, side, offset, ct), macKey);
  return { side, offset, ct, tag };
}

/** Verifies then decrypts. Throws if the message was forged or altered. */
export function open(pad: Uint8Array, chatId: string, msg: Sealed): Uint8Array {
  const [start] = padRange(pad, msg.side, msg.offset, msg.ct.length);
  const macKey = pad.subarray(start, start + MAC_KEY_BYTES);
  const expected = poly1305(authData(chatId, msg.side, msg.offset, msg.ct), macKey);
  if (msg.tag.length !== TAG_BYTES || !equalBytes(expected, msg.tag)) {
    throw new Error('Message failed authentication.');
  }
  const stream = pad.subarray(start + MAC_KEY_BYTES, start + MAC_KEY_BYTES + msg.ct.length);
  const out = new Uint8Array(msg.ct.length);
  for (let i = 0; i < out.length; i++) out[i] = msg.ct[i] ^ stream[i];
  return out;
}
