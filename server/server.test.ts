// Integration tests: start the real relay with plain `node` (no build step,
// no tsx) and talk to it over HTTP.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let child: ChildProcess;
let base: string;
let dataDir: string;

const CHAT = 'TestChatAAAAAAAAAAAAAA';
const KEY = 'k'.repeat(43);

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  dataDir = mkdtempSync(join(tmpdir(), 'padmessage-test-'));
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'production', TRUST_PROXY: '1' },
    stdio: 'pipe',
  });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('relay did not start');
});

afterAll(() => {
  child?.kill('SIGTERM');
  rmSync(dataDir, { recursive: true, force: true });
});

let nextOffset = 0;
/** A well-formed sealed message (the relay never checks the MAC; clients do). */
function message(ip = '10.0.0.1', offset = nextOffset) {
  nextOffset = offset + 64;
  return fetch(`${base}/api/chats/${CHAT}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-write-key': KEY, 'x-forwarded-for': ip },
    body: JSON.stringify({ side: 0, offset, ct: Buffer.alloc(32, 7).toString('base64'), tag: Buffer.alloc(16, 1).toString('base64') }),
  });
}

/** Minimal Server-Sent Events reader. */
async function events(path: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}${path}`, { headers, signal: ctrl.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  return {
    res,
    close: () => ctrl.abort(),
    /** Next real event (comments and retry hints skipped). */
    async next(): Promise<{ id?: string; event?: string; data?: string }> {
      for (;;) {
        const end = buf.indexOf('\n\n');
        if (end >= 0) {
          const frame = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const ev: Record<string, string> = {};
          for (const line of frame.split('\n')) {
            const m = line.match(/^(id|event|data): ?(.*)$/);
            if (m) ev[m[1]] = m[2];
          }
          if (ev.data !== undefined || ev.event) return ev;
          continue;
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for an event')), 3000)),
        ]);
        if (chunk.done) throw new Error('stream ended');
        buf += decoder.decode(chunk.value, { stream: true });
      }
    },
  };
}

describe('relay', () => {
  it('reports health', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('claims chats trust-on-first-use and enforces the write key', async () => {
    const noKey = await fetch(`${base}/api/chats/${CHAT}/messages`, { method: 'POST', body: '{}', headers: { 'x-forwarded-for': '10.9.0.1' } });
    expect(noKey.status).toBe(401);
    const claim = (writeKey: string) =>
      fetch(`${base}/api/chats/${CHAT}`, { method: 'PUT', body: JSON.stringify({ writeKey }), headers: { 'x-forwarded-for': '10.9.0.1' } });
    expect((await claim(KEY)).status).toBe(200);
    expect((await claim('x'.repeat(43))).status).toBe(403);
    expect((await message()).status).toBe(201);
  });

  it('refuses overlapping pad ranges for the same side', async () => {
    expect((await message('10.0.0.1', 0)).status).toBe(409);
    nextOffset = 1000;
  });

  it('streams history, then live messages, and resumes from Last-Event-ID', async () => {
    const stream = await events(`/api/events?chats=${CHAT}&after=0`);
    expect(stream.res.headers.get('content-type')).toContain('text/event-stream');
    const first = await stream.next();
    expect(first.id).toBe('1');
    expect(JSON.parse(first.data!).offset).toBe(0);

    const posted = await (await message()).json();
    const live = await stream.next();
    expect(live.id).toBe(String(posted.message.seq));
    stream.close();

    // A reconnecting browser sends Last-Event-ID; only newer messages replay.
    await message();
    const resumed = await events(`/api/events?chats=${CHAT}&after=0`, { 'last-event-id': live.id! });
    const replay = await resumed.next();
    expect(Number(replay.id)).toBe(posted.message.seq + 1);
    resumed.close();
  });

  it('streams several chats on one connection, sending photos as stubs', async () => {
    const OTHER = 'OtherChatAAAAAAAAAAAAA';
    const stream = await events(`/api/events?chats=${CHAT},${OTHER}&after=999999`);
    const post = (chat: string, offset: number, bytes: number) =>
      fetch(`${base}/api/chats/${chat}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-write-key': KEY, 'x-forwarded-for': '10.6.0.1' },
        body: JSON.stringify({ side: 1, offset, ct: Buffer.alloc(bytes, 9).toString('base64'), tag: Buffer.alloc(16).toString('base64') }),
      });
    expect((await post(OTHER, 0, 40)).status).toBe(201);
    expect((await post(CHAT, 0, 200 * 1024)).status).toBe(201); // a photo-sized message
    const small = JSON.parse((await stream.next()).data!);
    expect(small.chatId).toBe(OTHER);
    expect(small.size).toBe(40);
    expect(Buffer.from(small.ct, 'base64').length).toBe(40);
    const photo = JSON.parse((await stream.next()).data!);
    expect(photo.chatId).toBe(CHAT);
    expect(photo.size).toBe(200 * 1024);
    expect(photo.ct).toBeUndefined(); // body fetched over GET only when needed
    stream.close();

    // The newest message per chat, for the conversation list (stubbed the same way).
    const latest = await (await fetch(`${base}/api/latest?chats=${CHAT},${OTHER},NoMessagesAAAAAAAAAAAA`)).json();
    expect(latest.messages.map((m: { chatId: string }) => m.chatId).sort()).toEqual([CHAT, OTHER].sort());
    expect(latest.messages.find((m: { chatId: string }) => m.chatId === CHAT).ct).toBeUndefined();
    // GET history always carries full bodies.
    const full = await (await fetch(`${base}/api/chats/${CHAT}/messages?after=${photo.seq - 1}`)).json();
    expect(Buffer.from(full.messages[0].ct, 'base64').length).toBe(200 * 1024);

    expect((await fetch(`${base}/api/events?chats=not-a-chat-id`)).status).toBe(400);
    expect((await fetch(`${base}/api/latest`)).status).toBe(400);
  });

  it('rate-limits per client address behind a proxy', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const r = await fetch(`${base}/api/chats/${CHAT}/messages`, { method: 'POST', body: '{}', headers: { 'x-forwarded-for': '203.0.113.5' } });
      statuses.push(r.status);
    }
    expect(statuses.at(-1)).toBe(429);
    // Another client behind the same proxy is unaffected. The last entry is
    // the one the proxy appended; a client-supplied first entry is ignored.
    const other = await fetch(`${base}/api/chats/${CHAT}/messages`, {
      method: 'POST',
      body: '{}',
      headers: { 'x-forwarded-for': '203.0.113.5, 198.51.100.7' },
    });
    expect(other.status).toBe(401);
  });

  it('accepts image-sized messages up to 3 MB and pages history by size', async () => {
    const BIG = 'BigChatAAAAAAAAAAAAAAA';
    const post = (offset: number, bytes: number) =>
      fetch(`${base}/api/chats/${BIG}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-write-key': KEY, 'x-forwarded-for': '10.7.0.1' },
        body: JSON.stringify({ side: 0, offset, ct: Buffer.alloc(bytes, 3).toString('base64'), tag: Buffer.alloc(16).toString('base64') }),
      });
    const MB = 1024 * 1024;
    expect((await post(0, 3 * MB + 1)).status).toBe(413);
    for (let i = 0; i < 4; i++) expect((await post(i * 3 * MB, 2.5 * MB)).status).toBe(201);
    // 4 × 2.5 MB is over the 8 MB page budget: three fit, the fourth comes next.
    const first = await (await fetch(`${base}/api/chats/${BIG}/messages?after=0`)).json();
    expect(first.messages.length).toBe(3);
    expect(first.more).toBe(true);
    const next = await (await fetch(`${base}/api/chats/${BIG}/messages?after=${first.messages[2].seq}`)).json();
    expect(next.messages.length).toBe(1);
    expect(next.more).toBe(false);
  });

  it('rejects malformed paths and never serves files outside the app', async () => {
    expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(400);
    // An encoded slash survives URL normalization and decodes to ../ on the server.
    const escape = await fetch(`${base}/..%2fpackage.json`);
    expect(escape.status).toBe(404);
    // fetch itself resolves %2e%2e, so this asks for /package.json: the app shell, never the real file.
    const dotted = await fetch(`${base}/%2e%2e/package.json`);
    expect(await dotted.text()).not.toContain('"devDependencies"');
  });

  it.runIf(existsSync('dist/index.html'))('serves the app with a strict CSP, and HSTS over HTTPS', async () => {
    const plain = await fetch(`${base}/c/${CHAT}`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('content-security-policy')).toContain("connect-src 'self';");
    expect(plain.headers.get('strict-transport-security')).toBeNull();
    const viaHttpsProxy = await fetch(`${base}/`, { headers: { 'x-forwarded-proto': 'https' } });
    expect(viaHttpsProxy.headers.get('strict-transport-security')).toContain('max-age=');
  });
});
