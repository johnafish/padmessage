import './styles/app.css';
import { fetchLatest, fetchMessages } from './api.ts';
import { isChatId } from './crypto/pad.ts';
import { getChat, listChats, markRead, onChatsChanged, type ChatRecord } from './store.ts';
import { followChats, markSeen, onMessage, onResync } from './sync.ts';
import { mountChat } from './ui/chat.ts';
import { avatar, h, icon, installGlassPointer } from './ui/dom.ts';
import { previewOf, type Preview } from './ui/previews.ts';
import { listTime } from './ui/time.ts';
import { importPadSheet, newPadSheet } from './ui/sheets.ts';

installGlassPointer();

const list = h('nav', { class: 'chat-list', 'aria-label': 'Chats' });
const pane = h('main', { class: 'pane' });
const app = h(
  'div',
  { class: 'app', 'data-view': 'list' },
  h(
    'aside',
    { class: 'sidebar glass' },
    h(
      'div',
      { class: 'brand' },
      h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('logo')),
      h('div', { class: 'brand-name' }, 'PadMessage'),
    ),
    list,
    h(
      'div',
      { class: 'sidebar-actions' },
      h('button', { class: 'btn btn--sm glass glass--tinted glass--pill glass--interactive', onclick: () => newPadSheet(go) }, icon('plus'), 'New pad'),
      h('button', { class: 'btn btn--sm glass glass--pill glass--interactive', onclick: () => importPadSheet(go) }, icon('upload'), 'Load pad'),
    ),
  ),
  pane,
);

// Browsers only expose WebCrypto, Web Locks and the camera on secure origins
// (HTTPS, or localhost). Without them nothing can work, so say so plainly
// rather than failing on the first click.
const secure = window.isSecureContext && !!crypto.subtle;

document.body.append(h('div', { class: 'backdrop', 'aria-hidden': 'true' }), secure ? app : insecureNotice());

function insecureNotice() {
  return h(
    'div',
    { class: 'center' },
    h(
      'div',
      { class: 'hero glass' },
      h('div', { class: 'hero-orb glass glass--tinted' }, icon('lock')),
      h('h1', null, 'PadMessage needs a secure connection.'),
      h(
        'p',
        null,
        'Browsers only allow the encryption PadMessage relies on over HTTPS. This page was opened over plain HTTP, so it can’t create or open pads.',
      ),
      location.protocol === 'http:' &&
        h(
          'div',
          { class: 'hero-actions' },
          h('a', { class: 'btn glass glass--tinted glass--pill glass--interactive', href: location.href.replace(/^http:/, 'https:') }, 'Open the HTTPS address'),
        ),
      h('p', { class: 'hero-note' }, 'Running your own server? See “Self-hosting” in the README.'),
    ),
  );
}

// ---------- routing ----------

let unmount: (() => void) | null = null;
let currentChat: string | null = null;

function go(chatId: string | null) {
  history.pushState(null, '', chatId ? `/c/${chatId}` : '/');
  void route();
}

window.addEventListener('popstate', () => void route());

async function route() {
  const match = location.pathname.match(/^\/c\/([^/]+)\/?$/);
  const chatId = match && isChatId(match[1]) ? match[1] : null;
  unmount?.();
  unmount = null;
  currentChat = chatId;
  app.dataset.view = chatId ? 'chat' : 'list';
  await renderList();

  if (!chatId) return renderHome();
  if (await getChat(chatId)) {
    unmount = await mountChat(pane, chatId, {
      onBack: () => go(null),
      onChanged: () => void renderList(),
      onDeleted: () => go(null),
      onRead: (seq) => void markRead(chatId, seq), // the store announces the change
    });
  } else {
    renderLocked(chatId);
  }
}

// ---------- sidebar ----------

/** Newest message per chat, decrypted on the fly and never stored. */
const previews = new Map<string, Preview>();

let renderGeneration = 0;

async function renderList() {
  // Calls overlap (previews wait on the network), so only the newest one
  // draws, and it re-reads the list after waiting, so it is never stale.
  const generation = ++renderGeneration;
  await loadPreviews(await listChats());
  const chats = await listChats();
  if (generation !== renderGeneration) return;
  // One live stream covers every chat here; this reconnects only when the set changes.
  followChats(chats.map((c) => c.chatId));
  const activity = (c: ChatRecord) => Math.max(previews.get(c.chatId)?.at ?? 0, c.createdAt);
  chats.sort((a, b) => activity(b) - activity(a));
  list.replaceChildren(...chats.map(row));
  // Runs on every route change and rename, so the tab title stays current.
  const current = chats.find((c) => c.chatId === currentChat);
  document.title = current ? `${current.name} · PadMessage` : currentChat ? 'Locked chat · PadMessage' : 'PadMessage';
}

/** Fetches and decrypts the newest message of any chat that has no preview yet. */
async function loadPreviews(chats: ChatRecord[]) {
  const missing = chats.filter((c) => !previews.has(c.chatId));
  for (let i = 0; i < missing.length; i += 200) {
    const batch = missing.slice(i, i + 200);
    let latest;
    try {
      latest = await fetchLatest(batch.map((c) => c.chatId));
    } catch {
      return; // offline: previews appear once the relay is reachable
    }
    for (const m of latest) {
      const chat = batch.find((c) => c.chatId === m.chatId)!;
      setPreview(m.chatId, await previewOf(chat, m));
      markSeen(m.seq);
      // Chats from before unread tracking start out fully read.
      if (chat.readSeq === undefined) await markRead(chat.chatId, m.seq);
    }
  }
}

function setPreview(chatId: string, p: Preview) {
  if ((previews.get(chatId)?.seq ?? -1) < p.seq) previews.set(chatId, p);
}

// New, renamed, deleted or newly read chats, from this tab or another.
onChatsChanged(() => void renderList());

onMessage(async (m) => {
  const chat = await getChat(m.chatId);
  if (!chat) return;
  setPreview(m.chatId, await previewOf(chat, m));
  void renderList();
});
onResync(() => {
  previews.clear();
  void renderList();
});

function isUnread(chat: ChatRecord, p: Preview | undefined): boolean {
  if (!p || p.mine || p.seq <= (chat.readSeq ?? 0)) return false;
  // The open chat marks itself read as messages render; don't flash a dot meanwhile.
  return !(chat.chatId === currentChat && document.visibilityState === 'visible');
}

function row(chat: ChatRecord) {
  const active = chat.chatId === currentChat;
  const p = previews.get(chat.chatId);
  const unread = isUnread(chat, p);
  return h(
    'button',
    {
      class: `chat-row${active ? ' glass glass--clear' : ''}${unread ? ' chat-row--unread' : ''}`,
      'aria-current': String(active),
      onclick: () => go(chat.chatId),
    },
    h('span', { class: 'unread-dot', 'aria-hidden': 'true' }),
    avatar(chat.name, chat.chatId),
    h(
      'div',
      { class: 'chat-row-main' },
      h(
        'div',
        { class: 'chat-row-top' },
        h('span', { class: 'chat-row-name' }, chat.name),
        p && h('time', { class: 'chat-row-time', datetime: new Date(p.at).toISOString() }, listTime(p.at)),
      ),
      h('div', { class: 'chat-row-sub' }, unread && h('span', { class: 'sr-only' }, 'Unread: '), p ? p.text : 'No messages yet'),
    ),
  );
}

// ---------- empty states ----------

function renderHome() {
  pane.replaceChildren(
    h(
      'div',
      { class: 'center' },
      h(
        'div',
        { class: 'hero glass glass--track' },
        h('div', { class: 'hero-orb glass glass--tinted' }, icon('shield')),
        h('h1', null, 'The messenger you can make provably unbreakable.'),
        h(
          'p',
          null,
          'PadMessage encrypts with one-time pads: random keys you swap in person and never reuse. Make your pad from true hardware randomness and no amount of computing power, quantum or otherwise, can read your messages.',
        ),
        h(
          'div',
          { class: 'hero-actions' },
          h('button', { class: 'btn glass glass--tinted glass--pill glass--interactive', onclick: () => newPadSheet(go) }, icon('plus'), 'Create a pad'),
          h('button', { class: 'btn glass glass--pill glass--interactive', onclick: () => importPadSheet(go) }, icon('upload'), 'Load a pad'),
        ),
        h(
          'div',
          { class: 'hero-facts' },
          fact('Meet once', 'Swap a pad file face to face.'),
          fact('Stays here', 'Pads never leave your device.'),
          fact('Burns as you go', 'Every byte is used only once.'),
        ),
      ),
    ),
  );
}

function fact(title: string, text: string) {
  return h('div', { class: 'hero-fact glass glass--clear' }, h('b', null, title), text);
}

function renderLocked(chatId: string) {
  const count = h('p', { style: 'margin-top: -14px; font-size: 13px' });
  pane.replaceChildren(
    h(
      'div',
      { class: 'center' },
      h(
        'div',
        { class: 'hero glass glass--track' },
        h('button', { class: 'only-mobile btn btn--icon btn--sm glass glass--clear glass--pill glass--interactive sheet-close', 'aria-label': 'Back', onclick: () => go(null) }, icon('back')),
        h('div', { class: 'hero-orb glass glass--tinted' }, icon('lock')),
        h('h1', null, 'This chat is locked.'),
        h('p', null, 'Its messages can only be read with the matching pad. Load the pad file you got from the person who shared this link.'),
        count,
        h(
          'div',
          { class: 'hero-actions' },
          h('button', { class: 'btn glass glass--tinted glass--pill glass--interactive', onclick: () => importPadSheet(go, { expectChatId: chatId }) }, icon('upload'), 'Load pad'),
        ),
      ),
    ),
  );
  fetchMessages(chatId)
    .then((m) => {
      count.textContent = m.length
        ? `${m.length} sealed message${m.length === 1 ? '' : 's'} waiting.`
        : 'No messages here yet.';
    })
    .catch(() => count.remove());
}

if (secure) void route();
