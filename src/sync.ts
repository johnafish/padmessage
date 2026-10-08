// The device's single live connection to the relay. It covers every chat
// stored here, so the conversation list sees new messages (for previews and
// unread dots) and the open chat gets its own, all over one stream per tab.

import { openStream, type WireMessage } from './api.ts';

type Listener = (m: WireMessage) => void;

let chats: string[] = [];
let lastSeq = 0;
let close: (() => void) | null = null;
const messageListeners = new Set<Listener>();
const resyncListeners = new Set<() => void>();

/** Sets which chats to follow, reconnecting only if the set changed. */
export function followChats(chatIds: string[]) {
  const next = [...new Set(chatIds)].sort();
  if (next.join() === chats.join()) return;
  chats = next;
  close?.();
  // Resuming from lastSeq replays anything that arrived while switching.
  close = chats.length
    ? openStream(
        chats,
        lastSeq,
        (m) => {
          lastSeq = Math.max(lastSeq, m.seq);
          messageListeners.forEach((fn) => fn(m));
        },
        () => resyncListeners.forEach((fn) => fn()),
      )
    : null;
}

/** Tells the stream where to start: messages up to `seq` are already known. */
export function markSeen(seq: number) {
  lastSeq = Math.max(lastSeq, seq);
}

export function onMessage(fn: Listener): () => void {
  messageListeners.add(fn);
  return () => messageListeners.delete(fn);
}

/** The stream fell too far behind to replay; reload state over GET. */
export function onResync(fn: () => void): () => void {
  resyncListeners.add(fn);
  return () => resyncListeners.delete(fn);
}
