// Relay client. Everything sent here is ciphertext.

import type { Side } from './crypto/pad.ts';

export interface WireMessage {
  seq: number;
  side: Side;
  offset: number;
  ct: string;
  tag: string;
  receivedAt: number;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export async function fetchMessages(chatId: string, after = 0): Promise<WireMessage[]> {
  const all: WireMessage[] = [];
  for (;;) {
    const page = await call<{ messages: WireMessage[]; more: boolean }>(
      `/api/chats/${chatId}/messages?after=${after}`,
    );
    all.push(...page.messages);
    if (!page.more || page.messages.length === 0) return all;
    after = page.messages[page.messages.length - 1].seq;
  }
}

/** Registers the pad-derived write key for a chat, or checks it matches the one on file. */
export async function claimChat(chatId: string, writeKey: string): Promise<void> {
  await call(`/api/chats/${chatId}`, { method: 'PUT', body: JSON.stringify({ writeKey }) });
}

export async function postMessage(
  chatId: string,
  writeKey: string,
  msg: { side: Side; offset: number; ct: string; tag: string },
): Promise<WireMessage> {
  const { message } = await call<{ message: WireMessage }>(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: { 'X-Write-Key': writeKey },
    body: JSON.stringify(msg),
  });
  return message;
}

/** Live feed with automatic reconnect. Calls `onReconnect` so callers can backfill. */
export function subscribe(chatId: string, onMessage: (m: WireMessage) => void, onReconnect: () => void): () => void {
  let sock: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    sock = new WebSocket(`${proto}//${location.host}/ws/${chatId}`);
    sock.onopen = () => {
      if (retry > 0) onReconnect();
      retry = 0;
      ping = setInterval(() => sock?.readyState === WebSocket.OPEN && sock.send('ping'), 25_000);
    };
    sock.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'message') onMessage(data.message);
      } catch {
        /* ignore malformed frames */
      }
    };
    sock.onclose = () => {
      clearInterval(ping);
      if (closed) return;
      retry++;
      timer = setTimeout(connect, Math.min(15_000, 500 * 2 ** retry));
    };
  };
  connect();

  return () => {
    closed = true;
    clearTimeout(timer);
    clearInterval(ping);
    sock?.close();
  };
}
