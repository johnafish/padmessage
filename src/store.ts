// Local-only storage. Pads live in IndexedDB on this device and are never
// sent anywhere. Chat metadata is kept apart from pad bytes so listing chats
// does not load megabytes of key material.

import type { Side } from './crypto/pad.ts';

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
}

const DB_NAME = 'padmessage';
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('chats', { keyPath: 'chatId' });
      db.createObjectStore('pads');
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

export async function getPad(chatId: string): Promise<Uint8Array | undefined> {
  const db = await openDb();
  const buf: ArrayBuffer | undefined = await request(db.transaction('pads').objectStore('pads').get(chatId));
  return buf && new Uint8Array(buf);
}

export async function addChat(chat: ChatRecord, pad: Uint8Array): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['chats', 'pads'], 'readwrite');
  // add() rather than put(): importing the same pad twice must never reset its offset.
  tx.objectStore('chats').add(chat);
  tx.objectStore('pads').add(pad.slice().buffer, chat.chatId);
  await done(tx);
}

export async function updateChat(chatId: string, patch: Partial<Pick<ChatRecord, 'name' | 'lastActivity' | 'partnerExported'>>) {
  const db = await openDb();
  const tx = db.transaction('chats', 'readwrite');
  const store = tx.objectStore('chats');
  const chat: ChatRecord | undefined = await request(store.get(chatId));
  if (chat) store.put({ ...chat, ...patch });
  await done(tx);
}

export async function deleteChat(chatId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['chats', 'pads'], 'readwrite');
  tx.objectStore('chats').delete(chatId);
  tx.objectStore('pads').delete(chatId);
  await done(tx);
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
