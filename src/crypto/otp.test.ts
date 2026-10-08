import { describe, expect, it } from 'vitest';
import { poly1305 } from '@noble/ciphers/_poly1305.js';
import { costOf, costOfContent, frame, frameText, messageRange, open, openSlice, seal, unframe, unframeText, type Content } from './otp.ts';
import { checkRandomness, encodePadFile, entropyId, generatePad, halfSize, identifyPad, parsePadFile } from './pad.ts';

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

  it('opens from just the message\'s own pad bytes', () => {
    const sealed = seal(pad, chatId, 1, 640, frameText('slice me', 7));
    const [start, end] = messageRange(pad.length, 1, 640, sealed.ct.length);
    expect(unframeText(openSlice(pad.slice(start, end), chatId, sealed)).text).toBe('slice me');
    expect(() => openSlice(pad.slice(start, end - 1), chatId, sealed)).toThrow(/range/);
    expect(() => openSlice(pad.slice(start + 1, end + 1), chatId, sealed)).toThrow(/authentication/);
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
    const file = encodePadFile(body, 1, 'mixed');
    const parsed = parsePadFile(file);
    expect(parsed.side).toBe(1);
    expect(parsed.source).toBe('mixed');
    expect(parsed.body).toEqual(body);
    expect(parsePadFile(encodePadFile(body, 0, 'csprng')).source).toBe('csprng');
    expect(parsePadFile(body)).toMatchObject({ side: null, source: 'external' });
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

  it('mixes hardware randomness by XOR and refuses a short source', () => {
    const hw = generatePad(64 * 1024);
    const a = generatePad(64 * 1024, hw);
    const b = generatePad(64 * 1024, hw);
    // Same hardware input, independent browser output: the pads still differ.
    expect(a).not.toEqual(b);
    expect(() => generatePad(64 * 1024, hw.subarray(0, 1000))).toThrow(/smaller/);
  });

  it('identifies a reused hardware file regardless of how much was used', async () => {
    const hw = generatePad(256 * 1024);
    expect(await entropyId(hw)).toBe(await entropyId(hw.subarray(0, 128 * 1024)));
    expect(await entropyId(hw)).not.toBe(await entropyId(generatePad(256 * 1024)));
  });
});

describe('image messages', () => {
  const pad = generatePad(256 * 1024);
  const chatId = 'AAAAAAAAAAAAAAAAAAAAAA';
  const image: Content = {
    kind: 'image',
    mime: 'image/webp',
    width: 1280,
    height: 960,
    data: generatePad(20_000),
    caption: 'the view from here ⛰️',
  };

  it('round-trips through seal and open, with caption and dimensions', () => {
    const framed = frame(image, 42);
    const opened = unframe(open(pad, chatId, seal(pad, chatId, 1, 0, framed)));
    expect(opened.sentAt).toBe(42);
    expect(opened.content).toEqual(image);
  });

  it('costs exactly the pad bytes it seals', () => {
    const framed = frame(image, 0);
    expect(costOfContent(image)).toBe(32 + framed.length);
    expect(framed.length % 32).toBe(0);
  });

  it('keeps text messages readable through the generic decoder', () => {
    expect(unframe(frameText('hi', 5))).toEqual({ content: { kind: 'text', text: 'hi' }, sentAt: 5 });
  });

  it('rejects truncated or unknown frames', () => {
    const framed = frame(image, 0);
    expect(() => unframe(framed.subarray(0, 100))).toThrow();
    const unknownMime = framed.slice();
    unknownMime[10] = 99;
    expect(() => unframe(unknownMime)).toThrow();
    const unknownKind = framed.slice();
    unknownKind[1] = 7;
    expect(() => unframe(unknownKind)).toThrow(/Unknown/);
    expect(() => unframeText(framed)).toThrow(/Not a text/);
  });
});
