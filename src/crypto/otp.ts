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
/** Largest framed message; the relay refuses bigger ciphertexts. */
export const MAX_FRAME_BYTES = 3 * 1024 * 1024;

const VERSION = 1;
const KIND_TEXT = 1;
const KIND_IMAGE = 2;
// text:  version u8 | kind u8 | sentAt f64 | textLen u32 | text
const TEXT_HEADER = 14;
// image: version u8 | kind u8 | sentAt f64 | mime u8 | width u16 | height u16
//        | captionLen u32 | dataLen u32 | caption | data
const IMAGE_HEADER = 23;

export type ImageMime = 'image/webp' | 'image/jpeg';
const MIME_CODES: Record<ImageMime, number> = { 'image/webp': 1, 'image/jpeg': 2 };

export type Content =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mime: ImageMime; width: number; height: number; data: Uint8Array; caption: string };

export interface Opened {
  content: Content;
  sentAt: number;
}

export interface Sealed {
  side: Side;
  offset: number;
  ct: Uint8Array;
  tag: Uint8Array;
}

const utf8 = new TextEncoder();

function padded(length: number): number {
  return Math.ceil(length / BLOCK) * BLOCK;
}

function framedLength(content: Content): number {
  if (content.kind === 'text') return padded(TEXT_HEADER + utf8.encode(content.text).length);
  return padded(IMAGE_HEADER + utf8.encode(content.caption).length + content.data.length);
}

/** Pad bytes a message will consume. */
export function costOfContent(content: Content): number {
  return MAC_KEY_BYTES + framedLength(content);
}

/** Pad bytes a text message will consume. */
export function costOf(text: string): number {
  return costOfContent({ kind: 'text', text });
}

export function costOfCiphertext(ctLength: number): number {
  return MAC_KEY_BYTES + ctLength;
}

export function frame(content: Content, sentAt: number): Uint8Array {
  const out = new Uint8Array(framedLength(content));
  const view = new DataView(out.buffer);
  out[0] = VERSION;
  view.setFloat64(2, sentAt);
  if (content.kind === 'text') {
    const body = utf8.encode(content.text);
    out[1] = KIND_TEXT;
    view.setUint32(10, body.length);
    out.set(body, TEXT_HEADER);
  } else {
    const caption = utf8.encode(content.caption);
    out[1] = KIND_IMAGE;
    out[10] = MIME_CODES[content.mime];
    view.setUint16(11, content.width);
    view.setUint16(13, content.height);
    view.setUint32(15, caption.length);
    view.setUint32(19, content.data.length);
    out.set(caption, IMAGE_HEADER);
    out.set(content.data, IMAGE_HEADER + caption.length);
  }
  return out;
}

export function unframe(framed: Uint8Array): Opened {
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (framed.length < TEXT_HEADER || framed[0] !== VERSION) throw new Error('Unknown message format.');
  const sentAt = view.getFloat64(2);
  if (framed[1] === KIND_TEXT) {
    const len = view.getUint32(10);
    if (TEXT_HEADER + len > framed.length) throw new Error('Corrupt message frame.');
    return { content: { kind: 'text', text: decode(framed.subarray(TEXT_HEADER, TEXT_HEADER + len)) }, sentAt };
  }
  if (framed[1] === KIND_IMAGE && framed.length >= IMAGE_HEADER) {
    const mime = (Object.keys(MIME_CODES) as ImageMime[]).find((m) => MIME_CODES[m] === framed[10]);
    const captionLen = view.getUint32(15);
    const dataLen = view.getUint32(19);
    if (!mime || IMAGE_HEADER + captionLen + dataLen > framed.length) throw new Error('Corrupt message frame.');
    const caption = decode(framed.subarray(IMAGE_HEADER, IMAGE_HEADER + captionLen));
    // Copy, so the image doesn't keep the whole padded frame alive.
    const data = framed.slice(IMAGE_HEADER + captionLen, IMAGE_HEADER + captionLen + dataLen);
    return { content: { kind: 'image', mime, width: view.getUint16(11), height: view.getUint16(13), data, caption }, sentAt };
  }
  throw new Error('Unknown message format.');
}

export function frameText(text: string, sentAt: number): Uint8Array {
  return frame({ kind: 'text', text }, sentAt);
}

export function unframeText(framed: Uint8Array): { text: string; sentAt: number } {
  const { content, sentAt } = unframe(framed);
  if (content.kind !== 'text') throw new Error('Not a text message.');
  return { text: content.text, sentAt };
}

/** Absolute pad range [start, end) a message uses, or an error if it escapes the sender's half. */
export function messageRange(padLength: number, side: Side, offset: number, ctLength: number): [number, number] {
  const half = halfSize(padLength);
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
  const [start] = messageRange(pad.length, side, offset, framed.length);
  const macKey = pad.subarray(start, start + MAC_KEY_BYTES);
  const stream = pad.subarray(start + MAC_KEY_BYTES, start + MAC_KEY_BYTES + framed.length);
  const ct = new Uint8Array(framed.length);
  for (let i = 0; i < ct.length; i++) ct[i] = framed[i] ^ stream[i];
  const tag = poly1305(authData(chatId, side, offset, ct), macKey);
  return { side, offset, ct, tag };
}

/** Verifies then decrypts. Throws if the message was forged or altered. */
export function open(pad: Uint8Array, chatId: string, msg: Sealed): Uint8Array {
  const [start, end] = messageRange(pad.length, msg.side, msg.offset, msg.ct.length);
  return openSlice(pad.subarray(start, end), chatId, msg);
}

/**
 * `open` given only the message's own pad bytes (the range from
 * `messageRange`), so a caller can read just those bytes from storage.
 */
export function openSlice(padBytes: Uint8Array, chatId: string, msg: Sealed): Uint8Array {
  if (padBytes.length !== costOfCiphertext(msg.ct.length)) throw new Error('Wrong pad range for this message.');
  const macKey = padBytes.subarray(0, MAC_KEY_BYTES);
  const expected = poly1305(authData(chatId, msg.side, msg.offset, msg.ct), macKey);
  if (msg.tag.length !== TAG_BYTES || !equalBytes(expected, msg.tag)) {
    throw new Error('Message failed authentication.');
  }
  const stream = padBytes.subarray(MAC_KEY_BYTES);
  const out = new Uint8Array(msg.ct.length);
  for (let i = 0; i < out.length; i++) out[i] = msg.ct[i] ^ stream[i];
  return out;
}
