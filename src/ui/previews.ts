// Conversation-list previews. Each chat's newest message is verified and
// decrypted with just its own pad bytes, and kept in memory only:
// PadMessage never stores plaintext.

import type { WireMessage } from '../api.ts';
import { messageRange, openSlice, unframe } from '../crypto/otp.ts';
import { fromBase64 } from '../crypto/pad.ts';
import { getPadRange, type ChatRecord } from '../store.ts';

export interface Preview {
  seq: number;
  text: string;
  at: number;
  mine: boolean;
}

export async function previewOf(chat: ChatRecord, m: WireMessage): Promise<Preview> {
  const base = { seq: m.seq, mine: m.side === chat.side, at: m.receivedAt };
  // Only photos are big enough to arrive as stubs without their body.
  if (!m.ct) return { ...base, text: 'Photo' };
  const ct = fromBase64(m.ct);
  let plain: Uint8Array;
  try {
    const [start, end] = messageRange(chat.padLength, m.side, m.offset, ct.length);
    const bytes = await getPadRange(chat.chatId, start, end);
    if (!bytes) throw new Error('pad missing');
    plain = openSlice(bytes, chat.chatId, { side: m.side, offset: m.offset, ct, tag: fromBase64(m.tag) });
  } catch {
    return { ...base, mine: false, text: 'Message couldn’t be verified' };
  }
  try {
    const { content, sentAt } = unframe(plain);
    const text = content.kind === 'text' ? content.text : content.caption ? `Photo: ${content.caption}` : 'Photo';
    return { ...base, at: sentAt, text: text.replace(/\s+/g, ' ').trim() };
  } catch {
    return { ...base, text: 'Message' };
  }
}

/** iMessage-style list time: clock time today, then Yesterday, weekday, date. */
export function listTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (now.getTime() - ts < 6 * 24 * 60 * 60 * 1000) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: '2-digit' });
}
