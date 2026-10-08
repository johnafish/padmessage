import { describe, expect, it } from 'vitest';
import { poly1305 } from '@noble/ciphers/_poly1305.js';
import { costOf, frameText, open, seal, unframeText } from './otp.ts';
import { checkRandomness, encodePadFile, generatePad, halfSize, identifyPad, parsePadFile } from './pad.ts';

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));

describe('poly1305', () => {
  it('matches the RFC 8439 §2.5.2 test vector', () => {
    const key = hex('85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b');
    const msg = new TextEncoder().encode('Cryptographic Forum Research Group');
    expect(poly1305(msg, key)).toEqual(hex('a8061dc1305136c6c22b8baf0c0127a9'));
  });
});

describe('seal / open', () => {
  const pad = generatePad(128 * 1024);
  const chatId = 'AAAAAAAAAAAAAAAAAAAAAA';

  it('round-trips text on both sides', () => {
    for (const side of [0, 1] as const) {
      const framed = frameText('hello 🌙', 1234);
      const sealed = seal(pad, chatId, side, 96, framed);
      expect(sealed.ct).not.toEqual(framed);
      expect(unframeText(open(pad, chatId, sealed))).toEqual({ text: 'hello 🌙', sentAt: 1234 });
    }
  });

  it('pads plaintext to a block multiple and reports its cost', () => {
    const framed = frameText('hi', 0);
    expect(framed.length).toBe(32);
    expect(costOf('hi')).toBe(64);
  });

  it('rejects a flipped ciphertext bit', () => {
    const sealed = seal(pad, chatId, 0, 0, frameText('pay alice $10', 0));
    sealed.ct[20] ^= 1;
    expect(() => open(pad, chatId, sealed)).toThrow(/authentication/);
  });

  it('rejects a message replayed under a different offset, side, or chat', () => {
    const sealed = seal(pad, chatId, 0, 0, frameText('x', 0));
    expect(() => open(pad, chatId, { ...sealed, offset: 64 })).toThrow();
    expect(() => open(pad, chatId, { ...sealed, side: 1 })).toThrow();
    expect(() => open(pad, 'BBBBBBBBBBBBBBBBBBBBBB', sealed)).toThrow();
  });

  it('never lets a message cross into the other side', () => {
    const half = halfSize(pad.length);
    expect(() => seal(pad, chatId, 0, half - 32, frameText('x', 0))).toThrow(/outside/);
    expect(() => seal(pad, chatId, 1, half - 32, frameText('x', 0))).toThrow(/outside/);
    expect(() => seal(pad, chatId, 0, half - 64, frameText('x', 0))).not.toThrow();
  });

  it('uses disjoint pad bytes for each side at the same offset', () => {
    const framed = frameText('same', 0);
    const a = seal(pad, chatId, 0, 0, framed);
    const b = seal(pad, chatId, 1, 0, framed);
    expect(a.ct).not.toEqual(b.ct);
  });
});

describe('pad files', () => {
  it('round-trips the side header without changing identity', async () => {
    const body = generatePad(64 * 1024);
    const file = encodePadFile(body, 1);
    const parsed = parsePadFile(file);
    expect(parsed.side).toBe(1);
    expect(parsed.body).toEqual(body);
    expect(parsePadFile(body).side).toBeNull();
    expect(await identifyPad(parsed.body)).toEqual(await identifyPad(body));
  });

  it('formats ids and fingerprints', async () => {
    const id = await identifyPad(generatePad(64 * 1024));
    expect(id.chatId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(id.fingerprint).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  });

  it('flags non-random files', () => {
    expect(checkRandomness(generatePad(256 * 1024)).ok).toBe(true);
    const text = new TextEncoder().encode('the quick brown fox '.repeat(10000));
    expect(checkRandomness(text).ok).toBe(false);
    expect(checkRandomness(generatePad(1024)).ok).toBe(false);
  });
});
