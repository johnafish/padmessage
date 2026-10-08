import './styles/app.css';
import { fetchMessages } from './api.ts';
import { isChatId, SIDE_NAMES } from './crypto/pad.ts';
import { getChat, listChats, type ChatRecord } from './store.ts';
import { mountChat } from './ui/chat.ts';
import { avatar, h, icon, installGlassPointer, sideIcon } from './ui/dom.ts';
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
      h('div', { class: 'brand-mark' }, icon('pad')),
      h('div', { class: 'brand-name' }, 'padmessage'),
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

document.body.append(
  h('div', { class: 'backdrop', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span')),
  app,
);

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
    });
  } else {
    renderLocked(chatId);
  }
}

// ---------- sidebar ----------

async function renderList() {
  const chats = await listChats();
  list.replaceChildren(...chats.map(row));
}

function row(chat: ChatRecord) {
  const active = chat.chatId === currentChat;
  return h(
    'button',
    {
      class: `chat-row${active ? ' glass glass--clear' : ''}`,
      'aria-current': String(active),
      onclick: () => go(chat.chatId),
    },
    avatar(chat.name, chat.chatId),
    h(
      'div',
      { class: 'chat-row-main' },
      h('div', { class: 'chat-row-name' }, chat.name),
      h('div', { class: 'chat-row-sub' }, chat.fingerprint),
    ),
    h('span', { class: 'side-chip', 'data-side': chat.side, title: `You are ${SIDE_NAMES[chat.side]}` }, sideIcon(chat.side)),
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
          'padmessage encrypts with one-time pads: random keys you swap in person and never reuse. Make your pad from true hardware randomness and no amount of computing power, quantum or otherwise, can read your messages.',
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

void route();
