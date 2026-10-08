// PadMessage relay. The server never sees pads or plaintext: it stores sealed
// messages per chat, refuses any message whose pad range overlaps one already
// stored for the same side (a cheap guard against client bugs that would
// reuse pad bytes), and pushes new messages to open chats as Server-Sent
// Events.
//
// No npm dependencies: it runs on plain Node 22.18+ (`node server/index.ts`;
// Node strips the TypeScript types itself) using only built-in modules.
// Configuration is by environment variable; see "Self-hosting" in the README.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const env = process.env;
const PORT = Number(env.PORT ?? 8787);
const HOST = env.HOST || undefined; // all interfaces unless set
const PROD = env.NODE_ENV === 'production';
const DATA_DIR = resolve(env.DATA_DIR ?? 'data');
const DIST_DIR = resolve(env.DIST_DIR ?? 'dist');
const TLS_CERT = env.TLS_CERT;
const TLS_KEY = env.TLS_KEY;
/** Behind one reverse proxy, take the client address from the last X-Forwarded-For entry. */
const TRUST_PROXY = env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true';

if (!TLS_CERT !== !TLS_KEY) throw new Error('Set both TLS_CERT and TLS_KEY, or neither.');
const TLS = !!(TLS_CERT && TLS_KEY);

const MAC_KEY_BYTES = 32;
const TAG_BYTES = 16;
const MAX_CT_BYTES = 3 * 1024 * 1024; // matches MAX_FRAME_BYTES in the client
const MAX_BODY_BYTES = Math.ceil((MAX_CT_BYTES * 4) / 3) + 64 * 1024; // base64 + JSON
const PAGE_LIMIT = 500;
/** History pages also stop at this many ciphertext bytes, since images make messages large. */
const PAGE_BYTES = 8 * 1024 * 1024;
const STREAM_PING_MS = 25_000;
const MAX_STREAMS_PER_IP = 32;
/** One stream covers every chat on a device, up to this many. */
const MAX_STREAM_CHATS = 200;
/**
 * Streams and previews carry ciphertext only up to this size (any text
 * message fits). Bigger messages, i.e. photos, go out as a stub with their
 * size, and a client fetches the body over GET only if it needs it.
 */
const INLINE_CT_BYTES = 64 * 1024;
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

const sizesStmt = db.prepare('SELECT seq, length(ct) AS n FROM messages WHERE chat_id = ? AND seq > ? ORDER BY seq LIMIT ?');
const rangeStmt = db.prepare(
  'SELECT seq, chat_id, side, pad_offset, ct, tag, received_at FROM messages WHERE chat_id = ? AND seq > ? AND seq <= ? ORDER BY seq',
);
// Stream replay and previews: ciphertext only for small messages.
const SLIM_COLUMNS = `seq, chat_id, side, pad_offset, length(ct) AS size,
  CASE WHEN length(ct) <= ${INLINE_CT_BYTES} THEN ct END AS ct, tag, received_at`;
const replayStmt = db.prepare(
  `SELECT ${SLIM_COLUMNS} FROM messages WHERE chat_id IN (SELECT value FROM json_each(?)) AND seq > ? ORDER BY seq LIMIT ?`,
);
const latestStmt = db.prepare(`SELECT ${SLIM_COLUMNS} FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 1`);
const overlapStmt = db.prepare(
  'SELECT 1 FROM messages WHERE chat_id = ? AND side = ? AND pad_offset < ? AND pad_end > ? LIMIT 1',
);
const insertStmt = db.prepare(
  'INSERT INTO messages (chat_id, side, pad_offset, pad_end, ct, tag, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);

const getChatStmt = db.prepare('SELECT write_hash FROM chats WHERE chat_id = ?');
const claimStmt = db.prepare('INSERT INTO chats (chat_id, write_hash, created_at) VALUES (?, ?, ?)');

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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

/**
 * A message as sent to clients. `seq` is unique and increasing across the
 * whole relay, so one number is enough to resume a stream covering many
 * chats. `ct` is absent on stubs (see INLINE_CT_BYTES); `size` is always set.
 */
interface WireMessage {
  seq: number;
  chatId: string;
  side: 0 | 1;
  offset: number;
  size: number;
  ct?: string;
  tag: string;
  receivedAt: number;
}

type Row = {
  seq: number;
  chat_id: string;
  side: number;
  pad_offset: number;
  size?: number;
  ct: Uint8Array | null;
  tag: Uint8Array;
  received_at: number;
};

function toWire(row: Row): WireMessage {
  return {
    seq: row.seq,
    chatId: row.chat_id,
    side: row.side as 0 | 1,
    offset: row.pad_offset,
    size: row.size ?? row.ct!.length,
    ...(row.ct ? { ct: Buffer.from(row.ct).toString('base64') } : {}),
    tag: Buffer.from(row.tag).toString('base64'),
    receivedAt: row.received_at,
  };
}

/** The stream/preview form of a message: large bodies dropped. */
function slim(msg: WireMessage): WireMessage {
  if (msg.size <= INLINE_CT_BYTES) return msg;
  const { ct: _dropped, ...stub } = msg;
  return stub;
}

/**
 * The next page of a chat's history after `after`: at most PAGE_LIMIT
 * messages and (beyond the first) PAGE_BYTES of ciphertext. Sizes are read
 * first so large messages are never loaded just to be dropped. Synchronous,
 * like every node:sqlite call.
 */
function page(chatId: string, after: number): { rows: Row[]; more: boolean } {
  const sizes = sizesStmt.all(chatId, after, PAGE_LIMIT) as { seq: number; n: number }[];
  if (sizes.length === 0) return { rows: [], more: false };
  let bytes = 0;
  let count = 0;
  for (const { n } of sizes) {
    if (count > 0 && bytes + n > PAGE_BYTES) break;
    bytes += n;
    count++;
  }
  const rows = rangeStmt.all(chatId, after, sizes[count - 1].seq) as Row[];
  return { rows, more: count < sizes.length || sizes.length === PAGE_LIMIT };
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
    chatId,
    side,
    offset: start,
    size: ctBytes.length,
    ct: ctBytes.toString('base64'),
    tag: tagBytes.toString('base64'),
    receivedAt,
  };
}

// --- request helpers --------------------------------------------------------

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    // The proxy appends the address it saw, so the last entry is the one a
    // client can't forge (earlier entries are whatever the client sent).
    const hops = (header(req, 'x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress ?? '?';
}

function isHttps(req: IncomingMessage): boolean {
  return TLS || (TRUST_PROXY && header(req, 'x-forwarded-proto') === 'https');
}

function intParam(v: string | null | undefined): number {
  return Math.max(0, Math.floor(Number(v) || 0));
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

// --- live updates: Server-Sent Events ---------------------------------------
// One-way push is all the client needs, and SSE is plain HTTP: no library,
// it passes through any reverse proxy, and the browser reconnects on its own,
// sending Last-Event-ID so the stream can replay whatever it missed. A device
// opens one stream for all its chats, so the conversation list can show new
// messages and unread state without a connection per chat.

const rooms = new Map<string, Set<ServerResponse>>();
const streamsByIp = new Map<string, number>();

function eventFrame(msg: WireMessage): string {
  return `id: ${msg.seq}\ndata: ${JSON.stringify(slim(msg))}\n\n`;
}

/** Validated, de-duplicated chat ids from a comma-separated list. */
function chatList(raw: string | null): string[] {
  const ids = [...new Set((raw ?? '').split(',').filter(Boolean))];
  if (ids.length === 0 || ids.length > MAX_STREAM_CHATS) throw new HttpError(400, `list 1 to ${MAX_STREAM_CHATS} chats`);
  if (!ids.every((id) => CHAT_ID.test(id))) throw new HttpError(400, 'bad chat id');
  return ids;
}

function openStream(req: IncomingMessage, res: ServerResponse, url: URL) {
  const chats = chatList(url.searchParams.get('chats'));
  const ip = clientIp(req);
  const open = streamsByIp.get(ip) ?? 0;
  if (open >= MAX_STREAMS_PER_IP) throw new HttpError(429, 'too many open streams');
  const after = Math.max(intParam(url.searchParams.get('after')), intParam(header(req, 'last-event-id')));

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
  });
  // Replay and join the rooms in one synchronous block: node:sqlite is
  // synchronous, so no message can be stored between the query and the join.
  const rows = replayStmt.all(JSON.stringify(chats), after, PAGE_LIMIT) as Row[];
  let frames = 'retry: 3000\n\n' + rows.map((r) => eventFrame(toWire(r))).join('');
  // Too far behind to replay in one go: the client pages the rest over GET.
  if (rows.length === PAGE_LIMIT) frames += 'event: resync\ndata: {}\n\n';
  res.write(frames);

  for (const chatId of chats) {
    const room = rooms.get(chatId) ?? new Set();
    rooms.set(chatId, room);
    room.add(res);
  }
  streamsByIp.set(ip, open + 1);
  // Comment lines keep idle proxies and load balancers from closing the stream.
  const ping = setInterval(() => res.write(': ping\n\n'), STREAM_PING_MS);
  res.on('close', () => {
    clearInterval(ping);
    for (const chatId of chats) {
      const room = rooms.get(chatId);
      room?.delete(res);
      if (room?.size === 0) rooms.delete(chatId);
    }
    const left = (streamsByIp.get(ip) ?? 1) - 1;
    if (left > 0) streamsByIp.set(ip, left);
    else streamsByIp.delete(ip);
  });
}

function broadcast(chatId: string, msg: WireMessage) {
  const frame = eventFrame(msg);
  for (const res of rooms.get(chatId) ?? []) res.write(frame);
}

// --- http -----------------------------------------------------------------

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};

function sendJson(res: ServerResponse, status: number, data: unknown) {
  if (res.headersSent) return void res.end();
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

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'bad path');
  }
  let file = normalize(join(DIST_DIR, urlPath));
  if (file !== DIST_DIR && !file.startsWith(DIST_DIR + sep)) throw new HttpError(404, 'not found');
  const isAsset = existsSync(file) && statSync(file).isFile();
  if (!isAsset) file = join(DIST_DIR, 'index.html'); // SPA fallback for /c/<id> etc.
  if (!existsSync(file)) throw new HttpError(404, 'run `npm run build` first');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    ...(isHttps(req) ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': file.startsWith(join(DIST_DIR, 'assets') + sep) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/healthz') {
      db.prepare('SELECT 1').get();
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      return void res.end('ok');
    }
    const chatMatch = url.pathname.match(/^\/api\/chats\/([^/]+)$/);
    if (chatMatch && req.method === 'PUT') {
      if (!CHAT_ID.test(chatMatch[1])) throw new HttpError(400, 'bad chat id');
      if (!allow(clientIp(req))) throw new HttpError(429, 'slow down');
      const body = (await readJson(req)) as { writeKey?: unknown } | null;
      checkWriteKey(chatMatch[1], body?.writeKey);
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') return openStream(req, res, url);
    if (url.pathname === '/api/latest' && req.method === 'GET') {
      // Each listed chat's newest message, for the conversation list.
      const latest = chatList(url.searchParams.get('chats'))
        .map((id) => latestStmt.get(id) as Row | undefined)
        .filter((row): row is Row => !!row)
        .map((row) => toWire(row));
      return sendJson(res, 200, { messages: latest });
    }
    const match = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
    if (match) {
      const chatId = match[1];
      if (!CHAT_ID.test(chatId)) throw new HttpError(400, 'bad chat id');
      if (req.method === 'GET') {
        const { rows, more } = page(chatId, intParam(url.searchParams.get('after')));
        return sendJson(res, 200, { messages: rows.map(toWire), more });
      }
      if (req.method === 'POST') {
        if (!allow(clientIp(req))) throw new HttpError(429, 'slow down');
        checkWriteKey(chatId, req.headers['x-write-key']);
        const msg = postMessage(chatId, await readJson(req));
        broadcast(chatId, msg);
        return sendJson(res, 201, { message: msg });
      }
      throw new HttpError(405, 'method not allowed');
    }
    if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
    if (PROD) return serveStatic(req, res, url.pathname);
    sendJson(res, 404, { error: 'in development, open the Vite server on :5173' });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    sendJson(res, status, { error: err instanceof Error ? err.message : 'error' });
  }
}

// --- server ----------------------------------------------------------------

const loadTls = () => ({ cert: readFileSync(TLS_CERT!), key: readFileSync(TLS_KEY!) });

// With certificates, serve HTTP/2 (falling back to HTTP/1.1). Node's HTTP/2
// compatibility API mirrors http's request/response objects, so one handler
// serves both. HTTP/2 also lifts browsers' six-connections-per-host limit,
// which matters for event streams with many tabs open.
const server = TLS
  ? createSecureServer({ ...loadTls(), allowHTTP1: true }, handle as unknown as (req: Http2ServerRequest, res: Http2ServerResponse) => void)
  : createServer(handle);

if (TLS) {
  // Certificates renew (Let's Encrypt every ~60 days). Pick up new files
  // without a restart: on SIGHUP, and twice a day regardless.
  const reload = (announce: boolean) => {
    try {
      (server as ReturnType<typeof createSecureServer>).setSecureContext(loadTls());
      if (announce) console.log('Reloaded TLS certificate.');
    } catch (err) {
      console.error('Reloading the TLS certificate failed; keeping the old one.', err);
    }
  };
  process.on('SIGHUP', () => reload(true));
  setInterval(() => reload(false), 12 * 60 * 60 * 1000).unref();
}

function shutdown() {
  for (const room of rooms.values()) for (const res of room) res.end();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => {
  const where = `${TLS ? 'https' : 'http'}://${HOST ?? 'localhost'}:${PORT}`;
  console.log(`PadMessage relay listening on ${where}${PROD ? '' : ' (development: API only)'}`);
  if (PROD && !existsSync(join(DIST_DIR, 'index.html'))) console.warn(`No app build in ${DIST_DIR}. Run \`npm run build\` first.`);
  if (PROD && !TLS && !TRUST_PROXY) {
    console.warn(
      'Serving plain HTTP. Browsers only run PadMessage over HTTPS (localhost excepted): ' +
        'put it behind a TLS proxy and set TRUST_PROXY=1, or set TLS_CERT and TLS_KEY.',
    );
  }
});
