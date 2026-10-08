import type { PadSource } from '../crypto/pad.ts';

// Minimal DOM helpers. Text is always set via textContent; the only
// innerHTML is the constant icon set below.

type Child = Node | string | number | false | null | undefined;
type Props = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      el.className = value as string;
    } else if (key === 'style') {
      el.style.cssText = value as string; // CSSOM, so a strict style-src CSP still allows it

    } else if (key in el && typeof value !== 'string') {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: (Child | Child[])[]) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

const ICONS = {
  pad: '<path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  lock: '<rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  send: '<path d="M12 19V6M6 11.5 12 5.5l6 6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  back: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 12.5h9l1-12.5"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.3 2.9 7.9 7 9 4.1-1.1 7-4.7 7-9V6l-7-2.5Z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4L12 4Z"/><path d="M12 10v4.5M12 17.2v.1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10Z"/>',
  check: '<path d="m5.5 12.5 4 4 9-9"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  edit: '<path d="M4.5 19.5h4l10-10-4-4-10 10v4Z"/><path d="m13 7 4 4"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

export function sideIcon(side: 0 | 1) {
  return icon(side === 0 ? 'sun' : 'moon');
}

/** Pointer-tracked sheen for every .glass--interactive surface. */
export function installGlassPointer() {
  document.addEventListener(
    'pointermove',
    (e) => {
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('.glass--interactive, .glass--track');
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
      el.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
    },
    { passive: true },
  );
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = h('div', { class: 'toast glass glass--thick glass--pill', role: 'status' }, message);
  document.body.append(el);
  toastTimer = setTimeout(() => el.remove(), 2600);
}

export function download(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Deterministic avatar colours and initials from a chat id. */
export function avatar(name: string, chatId: string, size = 44): HTMLElement {
  let hash = 0;
  for (const ch of chatId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => [...w][0] ?? '')
      .join('')
      .toUpperCase() || '·';
  return h(
    'div',
    {
      class: 'avatar',
      style: `--size:${size}px;--a1:hsl(${hue} 85% 62%);--a2:hsl(${(hue + 50) % 360} 85% 52%)`,
      'aria-hidden': 'true',
    },
    initials,
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Rough count of short messages a number of pad bytes will carry. */
export function messagesLeft(bytes: number): string {
  const n = Math.floor(bytes / 96);
  return n >= 10000 ? `${Math.round(n / 1000)}k` : n.toLocaleString();
}

export const SOURCE_INFO: Record<PadSource | 'unknown', { label: string; detail: string }> = {
  mixed: {
    label: 'True random',
    detail:
      'Hardware randomness mixed with your browser’s generator. Messages are provably unbreakable, by any amount of computing, as long as the hardware source is truly random.',
  },
  csprng: {
    label: 'Browser random',
    detail:
      'Made with your browser’s cryptographic generator. Very strong, with no known attacks, but its security rests on computational assumptions like any modern cipher. Mix in hardware randomness for a provable guarantee.',
  },
  external: {
    label: 'Unverified',
    detail:
      'This file has no padmessage header, so there is no record of how it was made. It is only as strong as its source: true random if it came straight from a hardware generator, worthless if it didn’t.',
  },
  unknown: { label: 'Unknown source', detail: 'This pad was loaded before padmessage tracked where randomness came from.' },
};

export function sourceChip(source: PadSource | undefined) {
  const key = source ?? 'unknown';
  return h(
    'span',
    { class: 'source-chip', 'data-source': key, title: SOURCE_INFO[key].detail },
    icon(key === 'mixed' ? 'shield' : key === 'csprng' ? 'lock' : 'alert'),
    SOURCE_INFO[key].label,
  );
}
