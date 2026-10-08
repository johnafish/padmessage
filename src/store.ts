// Local-only storage. Pads live in IndexedDB on this device and are never
// sent anywhere. Chat metadata is kept apart from pad bytes so listing chats
// does not load megabytes of key material.

import type { PadSource, Side } from './crypto/pad.ts';

export interface ChatRecord {
  chatId: string;
  fingerprint: string;
  writeKey: string;
  name: string;
  side: Side;
  padLength: number;
  half: number;
  /** Next unused byte in this device's half. Only ever increases. */
  sendOffset: number;
  /** Offsets this device has reserved, to spot anyone else sending as our side. */
  sentOffsets: number[];
  /** Server high-water mark for our side when the pad was loaded; older messages are our own history. */
  historyFloor: number;
  createdAt: number;
  lastActivity: number;
  /** True once the partner copy of a generated pad has been exported. */
  partnerExported?: boolean;
  /** Where the pad's randomness came from. Missing on records made before this was tracked. */
  source?: PadSource;
  /** Highest message seq the user has seen in this chat. Missing on records made before unread tracking. */
  readSeq?: number;
}

const DB_NAME = 'padmessage';

// Chat-list changes are announced to this tab and, through a
// BroadcastChannel, to every other open tab, so the sidebar never needs a
// reload to show a new, renamed, deleted or newly read chat.
const changes = new EventTarget();
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('padmessage-chats') : null;
channel?.addEventListener('message', () => changes.dispatchEvent(new Event('change')));

function announceChange() {
  changes.dispatchEvent(new Event('change'));
  channel?.postMessage('change');
}

export function onChatsChanged(fn: () => void): () => void {
  changes.addEventListener('change', fn);
  return () => changes.removeEventListener('change', fn);
}
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('chats', { keyPath: 'chatId' });
        db.createObjectStore('pads');
      }
      // Ids of hardware randomness already mixed into a pad (see entropyId).
      if (e.oldVersion < 2) db.createObjectStore('entropy');
      // Pads were stored as ArrayBuffers; now Blobs, so a single message's
      // bytes can be read without loading the whole pad (see getPadRange).
      if (e.oldVersion >= 1 && e.oldVersion < 3) {
        const cursorReq = req.transaction!.objectStore('pads').openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          if (cursor.value instanceof ArrayBuffer) cursor.update(new Blob([cursor.value]));
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listChats(): Promise<ChatRecord[]> {
  const db = await openDb();
  const chats = await request(db.transaction('chats').objectStore('chats').getAll());
  return (chats as ChatRecord[]).sort((a, b) => b.lastActivity - a.lastActivity);
}

export async function getChat(chatId: string): Promise<ChatRecord | undefined> {
  const db = await openDb();
  return request(db.transaction('chats').objectStore('chats').get(chatId));
}

async function padValue(chatId: string): Promise<Blob | ArrayBuffer | undefined> {
  const db = await openDb();
  return request(db.transaction('pads').objectStore('pads').get(chatId));
}

export async function getPad(chatId: string): Promise<Uint8Array | undefined> {
  const value = await padValue(chatId);
  if (!value) return undefined;
  return new Uint8Array(value instanceof Blob ? await value.arrayBuffer() : value);
}

/** Bytes [start, end) of a pad, read without loading the rest of it. */
export async function getPadRange(chatId: string, start: number, end: number): Promise<Uint8Array | undefined> {
  const value = await padValue(chatId);
  if (!value) return undefined;
  if (value instanceof Blob) return new Uint8Array(await value.slice(start, end).arrayBuffer());
  return new Uint8Array(value, start, end - start);
}

export async function isEntropyUsed(id: string): Promise<boolean> {
  const db = await openDb();
  return (await request(db.transaction('entropy').objectStore('entropy').count(id))) > 0;
}

/** `entropyId` marks the hardware randomness mixed into this pad as spent, in the same transaction. */
export async function addChat(chat: ChatRecord, pad: Uint8Array, entropyId?: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['chats', 'pads', 'entropy'], 'readwrite');
  // add() rather than put(): importing the same pad twice must never reset its offset,
  // and a hardware dump already spent fails the whole transaction.
  tx.objectStore('chats').add({ readSeq: 0, ...chat });
  tx.objectStore('pads').add(new Blob([pad as BlobPart]), chat.chatId);
  if (entropyId) tx.objectStore('entropy').add(chat.chatId, entropyId);
  await done(tx);
  announceChange();
}

export async function updateChat(chatId: string, patch: Partial<Pick<ChatRecord, 'name' | 'lastActivity' | 'partnerExported'>>) {
  const db = await openDb();
  const tx = db.transaction('chats', 'readwrite');
  const store = tx.objectStore('chats');
  const chat: ChatRecord | undefined = await request(store.get(chatId));
  if (chat) store.put({ ...chat, ...patch });
  await done(tx);
  announceChange();
}

/** Records that the user has seen messages up to `seq`. Only ever moves forward. */
export async function markRead(chatId: string, seq: number): Promise<boolean> {
  const db = await openDb();
  const tx = db.transaction('chats', 'readwrite');
  const store = tx.objectStore('chats');
  const chat: ChatRecord | undefined = await request(store.get(chatId));
  const changed = !!chat && seq > (chat.readSeq ?? -1);
  if (changed) store.put({ ...chat, readSeq: seq });
  await done(tx);
  if (changed) announceChange();
  return changed;
}

export async function deleteChat(chatId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['chats', 'pads'], 'readwrite');
  tx.objectStore('chats').delete(chatId);
  tx.objectStore('pads').delete(chatId);
  await done(tx);
  announceChange();
}

export class PadExhaustedError extends Error {
  constructor() {
    super('Your half of this pad is used up. Exchange a new pad to keep talking.');
  }
}

/**
 * Atomically claims `cost` bytes from this device's half and returns their
 * offset. `floor` is the highest byte the server has seen us use, so a
 * restored or stale local copy still skips past bytes already spent. The
 * claim is committed before any encryption happens: if sending later fails,
 * those bytes are burned, never retried with different plaintext.
 */
export async function reserve(chatId: string, cost: number, floor: number): Promise<number> {
  const claim = async () => {
    const db = await openDb();
    const tx = db.transaction('chats', 'readwrite');
    const store = tx.objectStore('chats');
    const chat: ChatRecord | undefined = await request(store.get(chatId));
    if (!chat) throw new Error('Chat not found on this device.');
    const offset = Math.max(chat.sendOffset, floor);
    if (offset + cost > chat.half) {
      tx.abort();
      throw new PadExhaustedError();
    }
    store.put({
      ...chat,
      sendOffset: offset + cost,
      sentOffsets: [...chat.sentOffsets, offset],
      lastActivity: Date.now(),
    });
    await done(tx);
    return offset;
  };
  // IndexedDB serialises readwrite transactions already; the Web Lock also
  // covers the gap between tabs that read the server floor at different times.
  return navigator.locks ? navigator.locks.request(`pad:${chatId}`, claim) : claim();
}
