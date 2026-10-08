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

/**
 * Live feed of new messages after `after`, over Server-Sent Events. The
 * browser reconnects by itself and resumes from the last event it saw; if
 * the server refuses outright (e.g. too many open chats) we retry with
 * backoff. `onResync` fires when the server says we're too far behind for it
 * to replay, so the caller should page through the history instead.
 */
export function subscribe(
  chatId: string,
  after: number,
  onMessage: (m: WireMessage) => void,
  onResync: () => void,
): () => void {
  let source: EventSource | null = null;
  let closed = false;
  let lastSeq = after;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    source = new EventSource(`/api/chats/${chatId}/events?after=${lastSeq}`);
    source.onmessage = (e) => {
      retry = 0;
      try {
        const m = JSON.parse(e.data) as WireMessage;
        lastSeq = Math.max(lastSeq, m.seq);
        onMessage(m);
      } catch {
        /* ignore malformed events */
      }
    };
    source.addEventListener('resync', onResync);
    source.onerror = () => {
      // Transient drops are retried by EventSource itself; only a refused
      // connection leaves it CLOSED.
      if (closed || source?.readyState !== EventSource.CLOSED) return;
      retry++;
      timer = setTimeout(connect, Math.min(15_000, 1000 * 2 ** retry));
    };
  };
  connect();

  return () => {
    closed = true;
    clearTimeout(timer);
    source?.close();
  };
}
