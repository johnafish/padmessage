// iMessage-style relative times, shared by the conversation list and the
// time headers inside a chat.

const DAY_MS = 24 * 60 * 60 * 1000;

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "Today", "Yesterday", or a weekday within the past week; otherwise null. */
function recentDay(d: Date, now = new Date()): string | null {
  if (d.toDateString() === now.toDateString()) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  if (d < now && now.getTime() - d.getTime() < 6 * DAY_MS) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return null;
}

/** Conversation list: clock time today, then Yesterday, weekday, date. */
export function listTime(ts: number): string {
  const d = new Date(ts);
  const day = recentDay(d);
  if (day === 'Today') return clock(d);
  return day ?? d.toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: '2-digit' });
}

/** In-chat header, e.g. "Today 5:28 PM" or "Sun, Sep 20 at 4:10 PM"; `day` is shown bold. */
export function headerTime(ts: number): { day: string; time: string; full: string } {
  const d = new Date(ts);
  const full = d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' });
  const day = recentDay(d);
  if (day) return { day, time: clock(d), full };
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
  return { day: date, time: `at ${clock(d)}`, full };
}
