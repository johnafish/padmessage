// Ciphertext relay. The server never sees pads or plaintext: it stores sealed
// messages per chat, refuses any message whose pad range overlaps one already
// stored for the same side (a cheap guard against client bugs that would
// reuse pad bytes), and fans new messages out over WebSockets.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, type WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 8787);
const PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = resolve(process.env.DATA_DIR ?? 'data');
const DIST_DIR = resolve('dist');

const MAC_KEY_BYTES = 32;
const TAG_BYTES = 16;
const MAX_CT_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const PAGE_LIMIT = 500;
const CHAT_ID = /^[A-Za-z0-9_-]{22}$/;

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'padmessage.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS messages (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT    NOT NULL,
    side        INTEGER NOT NULL,
    pad_offset  INTEGER NOT NULL,
    pad_end     INTEGER NOT NULL,
    ct          BLOB    NOT NULL,
    tag         BLOB    NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_chat_seq ON messages (chat_id, seq);
  CREATE INDEX IF NOT EXISTS messages_chat_range ON messages (chat_id, side, pad_offset);
  CREATE TABLE IF NOT EXISTS chats (
    chat_id    TEXT PRIMARY KEY,
    write_hash BLOB    NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const listStmt = db.prepare(
  'SELECT seq, side, pad_offset, ct, tag, received_at FROM messages WHERE chat_id = ? AND seq > ? ORDER BY seq LIMIT ?',
);
const overlapStmt = db.prepare(
  'SELECT 1 FROM messages WHERE chat_id = ? AND side = ? AND pad_offset < ? AND pad_end > ? LIMIT 1',
);
const insertStmt = db.prepare(
  'INSERT INTO messages (chat_id, side, pad_offset, pad_end, ct, tag, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);

const getChatStmt = db.prepare('SELECT write_hash FROM chats WHERE chat_id = ?');
const claimStmt = db.prepare('INSERT INTO chats (chat_id, write_hash, created_at) VALUES (?, ?, ?)');

/**
 * Chats are claimed trust-on-first-use by the first client to present a
 * write key (derived from the pad, so only pad holders have it). Clients
 * claim as soon as a pad is created or loaded. We store only its hash.
 */
function checkWriteKey(chatId: string, key: unknown) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new HttpError(401, 'missing write key');
  const hash = createHash('sha256').update(key).digest();
  const row = getChatStmt.get(chatId) as { write_hash: Uint8Array } | undefined;
  if (!row) {
    claimStmt.run(chatId, hash, Date.now());
    return;
  }
  if (!timingSafeEqual(Buffer.from(row.write_hash), hash)) throw new HttpError(403, 'write key does not match this chat');
}

interface WireMessage {
  seq: number;
  side: 0 | 1;
  offset: number;
  ct: string;
  tag: string;
  receivedAt: number;
}

type Row = { seq: number; side: number; pad_offset: number; ct: Uint8Array; tag: Uint8Array; received_at: number };

function toWire(row: Row): WireMessage {
  return {
    seq: row.seq,
    side: row.side as 0 | 1,
    offset: row.pad_offset,
    ct: Buffer.from(row.ct).toString('base64'),
    tag: Buffer.from(row.tag).toString('base64'),
    receivedAt: row.received_at,
  };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function postMessage(chatId: string, body: unknown): WireMessage {
  const { side, offset, ct, tag } = (body ?? {}) as Record<string, unknown>;
  if (side !== 0 && side !== 1) throw new HttpError(400, 'side must be 0 or 1');
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new HttpError(400, 'bad offset');
  if (typeof ct !== 'string' || typeof tag !== 'string') throw new HttpError(400, 'ct and tag are required');
  const ctBytes = Buffer.from(ct, 'base64');
  const tagBytes = Buffer.from(tag, 'base64');
  if (ctBytes.length === 0 || ctBytes.length > MAX_CT_BYTES) throw new HttpError(413, 'ciphertext size out of range');
  if (tagBytes.length !== TAG_BYTES) throw new HttpError(400, 'bad tag');

  const start = offset as number;
  const end = start + MAC_KEY_BYTES + ctBytes.length;
  const receivedAt = Date.now();
  // node:sqlite is synchronous, so check-then-insert cannot interleave.
  if (overlapStmt.get(chatId, side, end, start)) {
    throw new HttpError(409, 'pad range already used by this side');
  }
  const { lastInsertRowid } = insertStmt.run(chatId, side, start, end, ctBytes, tagBytes, receivedAt);
  return {
    seq: Number(lastInsertRowid),
    side,
    offset: start,
    ct: ctBytes.toString('base64'),
    tag: tagBytes.toString('base64'),
    receivedAt,
  };
}

// --- rate limiting: a token bucket per client address --------------------

const buckets = new Map<string, { tokens: number; at: number }>();
function allow(ip: string, ratePerSec = 3, burst = 30): boolean {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: burst, at: now };
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * ratePerSec);
  b.at = now;
  buckets.set(ip, b);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, b] of buckets) if (b.at < cutoff) buckets.delete(ip);
}, 60_000).unref();

// --- realtime fan-out -----------------------------------------------------

const rooms = new Map<string, Set<WebSocket>>();
function broadcast(chatId: string, msg: WireMessage) {
  const payload = JSON.stringify({ type: 'message', message: msg });
  for (const sock of rooms.get(chatId) ?? []) if (sock.readyState === sock.OPEN) sock.send(payload);
}

// --- http -----------------------------------------------------------------

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let file = normalize(join(DIST_DIR, urlPath));
  if (!file.startsWith(DIST_DIR)) return sendJson(res, 404, { error: 'not found' });
  const isAsset = existsSync(file) && statSync(file).isFile();
  if (!isAsset) file = join(DIST_DIR, 'index.html'); // SPA fallback for /c/<id> etc.
  if (!existsSync(file)) return sendJson(res, 404, { error: 'run `npm run build` first' });
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': file.includes(`${DIST_DIR}/assets/`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    const chatMatch = url.pathname.match(/^\/api\/chats\/([^/]+)$/);
    if (chatMatch && req.method === 'PUT') {
      if (!CHAT_ID.test(chatMatch[1])) throw new HttpError(400, 'bad chat id');
      if (!allow(req.socket.remoteAddress ?? '?')) throw new HttpError(429, 'slow down');
      const body = (await readJson(req)) as { writeKey?: unknown } | null;
      checkWriteKey(chatMatch[1], body?.writeKey);
      return sendJson(res, 200, { ok: true });
    }
    const match = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
    if (match) {
      const chatId = match[1];
      if (!CHAT_ID.test(chatId)) throw new HttpError(400, 'bad chat id');
      if (req.method === 'GET') {
        const after = Math.max(0, Number(url.searchParams.get('after') ?? 0) || 0);
        const rows = listStmt.all(chatId, after, PAGE_LIMIT) as Row[];
        return sendJson(res, 200, { messages: rows.map(toWire), more: rows.length === PAGE_LIMIT });
      }
      if (req.method === 'POST') {
        if (!allow(req.socket.remoteAddress ?? '?')) throw new HttpError(429, 'slow down');
        checkWriteKey(chatId, req.headers['x-write-key']);
        const msg = postMessage(chatId, await readJson(req));
        broadcast(chatId, msg);
        return sendJson(res, 201, { message: msg });
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
    if (PROD) return serveStatic(req, res);
    sendJson(res, 404, { error: 'in development, open the Vite server on :5173' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    sendJson(res, status, { error: err instanceof Error ? err.message : 'error' });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
server.on('upgrade', (req, socket, head) => {
  const chatId = new URL(req.url ?? '/', 'http://x').pathname.match(/^\/ws\/([^/]+)$/)?.[1];
  if (!chatId || !CHAT_ID.test(chatId)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    const room = rooms.get(chatId) ?? new Set();
    rooms.set(chatId, room);
    room.add(ws);
    ws.on('close', () => {
      room.delete(ws);
      if (room.size === 0) rooms.delete(chatId);
    });
    ws.on('message', () => {}); // clients only listen; pings keep proxies happy
  });
});

server.listen(PORT, () => console.log(`padmessage relay on http://localhost:${PORT}${PROD ? '' : ' (dev)'}`));
