import { fetchMessages, postMessage, subscribe, type WireMessage } from '../api.ts';
import { costOf, costOfCiphertext, frameText, MAX_TEXT_CHARS, open, seal, unframeText } from '../crypto/otp.ts';
import { fromBase64, toBase64, type Side } from '../crypto/pad.ts';
import { deleteChat, getChat, getPad, PadExhaustedError, reserve } from '../store.ts';
import { avatar, formatBytes, h, icon, messagesLeft, sourceChip, toast } from './dom.ts';
import { confirmSheet, exportPartnerCopy, renameSheet } from './sheets.ts';

interface Item {
  /** `${side}:${offset}`: unique, since a side never reuses an offset. */
  key: string;
  seq: number; // Infinity while pending
  mine: boolean;
  status: 'ok' | 'pending' | 'failed' | 'tampered';
  text: string;
  sentAt: number;
}

export interface ChatCallbacks {
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}

export async function mountChat(container: HTMLElement, chatId: string, cb: ChatCallbacks): Promise<() => void> {
  let chat = (await getChat(chatId))!;
  const pad = (await getPad(chatId))!;
  const sentOffsets = new Set(chat.sentOffsets);
  const highWater: [number, number] = [0, 0];
  const items = new Map<string, Item>();
  const nodes = new Map<string, HTMLElement>();
  let lastSeq = 0;
  let collision = false;

  // ----- layout -----

  let av = avatar(chat.name, chatId);
  const nameEl = h('div', { class: 'chat-head-name' }, chat.name);
  const gauge = h('div', { class: 'gauge' });
  const gaugeLabel = h('span', { class: 'gauge-label' });
  const gaugeWrap = h('div', { class: 'gauge-wrap' }, gauge, gaugeLabel);
  const menuAnchor = h('div', { style: 'position: relative' });
  const moreBtn = h(
    'button',
    { class: 'btn btn--icon btn--sm glass glass--clear glass--pill glass--interactive', 'aria-label': 'Chat options', 'aria-haspopup': 'menu', onclick: () => toggleMenu() },
    icon('more'),
  );
  menuAnchor.append(moreBtn);

  const head = h(
    'header',
    { class: 'chat-head glass glass--track' },
    h('button', { class: 'only-mobile btn btn--icon btn--sm glass glass--clear glass--pill glass--interactive', 'aria-label': 'Back', onclick: cb.onBack }, icon('back')),
    av,
    h(
      'div',
      { class: 'chat-head-main' },
      nameEl,
      h(
        'div',
        { class: 'chat-head-sub' },
        sourceChip(chat.source),
        h('span', { class: 'fingerprint', title: 'Pad fingerprint' }, chat.fingerprint),
      ),
    ),
    h(
      'div',
      { class: 'chat-head-tools' },
      gaugeWrap,
      h(
        'button',
        { class: 'copy-link btn btn--icon btn--sm glass glass--clear glass--pill glass--interactive', 'aria-label': 'Copy chat link', title: 'Copy chat link', onclick: copyLink },
        icon('link'),
      ),
      menuAnchor,
    ),
  );

  const list = h('div', { class: 'messages', role: 'log', 'aria-live': 'polite' });
  const banner = h('div', { class: 'banner glass glass--tinted', role: 'alert', hidden: true });

  const textarea = h('textarea', { rows: 1, placeholder: 'Message', maxlength: MAX_TEXT_CHARS, 'aria-label': 'Message' });
  const cost = h('div', { class: 'composer-cost' });
  const sendBtn = h(
    'button',
    { class: 'send glass glass--tinted glass--pill glass--interactive', 'aria-label': 'Send', disabled: true, onclick: () => void send() },
    icon('send'),
  );
  const composer = h(
    'div',
    { class: 'composer glass glass--track' },
    h('div', { class: 'composer-field glass-well' }, textarea, cost),
    sendBtn,
  );

  const root = h('section', { class: 'chat' }, head, banner, list, composer);
  container.replaceChildren(root);

  // The header and composer float over the list and change height (header
  // compaction, a multi-line draft), so the list's padding tracks them.
  const spacing = new ResizeObserver(() => {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    root.style.setProperty('--head-space', `${head.offsetTop + head.offsetHeight}px`);
    root.style.setProperty('--composer-space', `${root.clientHeight - composer.offsetTop}px`);
    if (nearBottom) list.scrollTop = list.scrollHeight;
  });
  [root, head, composer].forEach((el) => spacing.observe(el));

  // ----- pad accounting -----

  function remaining() {
    return chat.half - Math.max(chat.sendOffset, highWater[chat.side]);
  }

  function updateGauge() {
    const left = remaining();
    const pct = Math.max(0, Math.round((left / chat.half) * 100));
    gauge.style.setProperty('--pct', String(pct));
    gauge.style.setProperty('--gauge-color', pct < 10 ? 'var(--danger)' : pct < 25 ? 'var(--warn)' : 'var(--accent-2)');
    gaugeLabel.textContent = `${pct}`;
    gaugeWrap.title = `${formatBytes(left)} of your half left (≈${messagesLeft(left)} messages)`;
    updateCost();
  }

  function updateCost() {
    const text = textarea.value.trim();
    const left = remaining();
    const need = text ? costOf(text) : 0;
    cost.dataset.warn = String(need > left || left / chat.half < 0.1);
    cost.textContent = need > left
      ? 'Not enough pad left for this message'
      : text
        ? `Uses ${formatBytes(need)} of pad · ${formatBytes(left)} left`
        : `${formatBytes(left)} of pad left · ≈${messagesLeft(left)} messages`;
    sendBtn.disabled = !text || need > left || collision;
  }

  // ----- receiving -----

  async function ingest(wire: WireMessage) {
    lastSeq = Math.max(lastSeq, wire.seq);
    const side = wire.side as Side;
    const key = `${side}:${wire.offset}`;
    const ct = fromBase64(wire.ct);
    const mine = side === chat.side;

    let opened;
    try {
      opened = unframeText(open(pad, chatId, { side, offset: wire.offset, ct, tag: fromBase64(wire.tag) }));
    } catch {
      // Forged or corrupt. It never counts toward pad usage, so junk can't burn the pad.
      items.set(key, { key, seq: wire.seq, mine: false, status: 'tampered', text: '', sentAt: wire.receivedAt });
      return;
    }
    highWater[side] = Math.max(highWater[side], wire.offset + costOfCiphertext(ct.length));

    if (mine && wire.offset >= chat.historyFloor && !sentOffsets.has(wire.offset)) {
      // Another tab on this device may have sent it; check the stored record before alarming.
      chat = (await getChat(chatId)) ?? chat;
      chat.sentOffsets.forEach((o) => sentOffsets.add(o));
      if (!sentOffsets.has(wire.offset)) flagCollision();
    }
    items.set(key, { key, seq: wire.seq, mine, status: 'ok', ...opened });
  }

  function flagCollision() {
    if (collision) return;
    collision = true;
    banner.hidden = false;
    banner.replaceChildren(
      h('b', null, 'Someone else is using your half of the pad. '),
      'Messages are arriving from your half that this device didn’t send. Your partner may have picked the same half, or the pad was copied. Sending is paused to protect the pad. Exchange a new pad.',
    );
    updateCost();
  }

  async function backfill() {
    const fresh = await fetchMessages(chatId, lastSeq);
    for (const m of fresh) await ingest(m);
    draw();
  }

  // ----- sending -----

  async function send() {
    const text = textarea.value.trim();
    if (!text || collision) return;
    const need = costOf(text);
    let offset: number;
    try {
      offset = await reserve(chatId, need, highWater[chat.side]);
    } catch (err) {
      toast(err instanceof PadExhaustedError ? err.message : 'Couldn’t reserve pad bytes');
      return;
    }
    sentOffsets.add(offset);
    chat = { ...chat, sendOffset: offset + need };
    textarea.value = '';
    autosize();

    const sentAt = Date.now();
    const key = `${chat.side}:${offset}`;
    items.set(key, { key, seq: Infinity, mine: true, status: 'pending', text, sentAt });
    draw(true);

    const sealed = seal(pad, chatId, chat.side, offset, frameText(text, sentAt));
    try {
      const wire = await postMessage(chatId, chat.writeKey, { side: chat.side, offset, ct: toBase64(sealed.ct), tag: toBase64(sealed.tag) });
      const existing = items.get(key);
      if (existing?.status !== 'ok') items.set(key, { key, seq: wire.seq, mine: true, status: 'ok', text, sentAt });
      highWater[chat.side] = Math.max(highWater[chat.side], offset + need);
      lastSeq = Math.max(lastSeq, wire.seq);
    } catch (err) {
      console.warn('send failed', err);
      items.set(key, { key, seq: Infinity, mine: true, status: 'failed', text, sentAt });
    }
    draw();
    cb.onChanged();
  }

  function retry(item: Item) {
    items.delete(item.key);
    textarea.value = item.text;
    autosize();
    draw();
    void send();
  }

  // ----- rendering -----

  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

  function bubbleFor(item: Item, contPrev: boolean, contNext: boolean): HTMLElement {
    let el = nodes.get(item.key);
    const sig = `${item.status}|${item.seq}`;
    if (!el || el.dataset.sig !== sig) {
      const fresh = buildBubble(item);
      if (el) el.replaceWith(fresh); // replacing in place keeps the list order stable
      el = fresh;
      el.dataset.sig = sig;
      nodes.set(item.key, el);
    }
    el.classList.toggle('bubble--cont-prev', contPrev);
    el.classList.toggle('bubble--cont-next', contNext);
    return el;
  }

  function buildBubble(item: Item): HTMLElement {
    if (item.status === 'tampered') {
      return h(
        'div',
        { class: 'bubble bubble--alert glass glass--tinted' },
        h('b', null, 'A message failed verification. '),
        'It was changed in transit or wasn’t made with this pad, so it was discarded.',
      );
    }
    const meta = h('div', { class: 'bubble-meta' }, timeFmt.format(item.sentAt));
    const el = h(
      'div',
      {
        class: `bubble ${item.mine ? 'bubble--mine glass glass--tinted' : 'bubble--theirs glass'} ${item.status === 'pending' ? 'bubble--pending' : ''} ${item.status === 'failed' ? 'bubble--failed' : ''}`,
      },
      item.text,
      meta,
    );
    if (item.status === 'failed') {
      meta.replaceChildren(
        h(
          'button',
          { class: 'glass--interactive', style: 'text-decoration: underline; font-size: inherit', onclick: () => retry(item) },
          'Not delivered. Tap to retry',
        ),
      );
      el.title = 'The pad bytes for this attempt are burned and won’t be reused.';
    }
    return el;
  }

  // Delivery status sits under your latest message only, as in most messengers.
  // "Delivered" means the relay has stored it: it answers a send only after the
  // write, and our own messages echo back over the socket only after it too.
  const status = h('div', { class: 'msg-status' });

  function draw(forceScroll = false) {
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    const ordered = [...items.values()].sort((a, b) => a.seq - b.seq || a.sentAt - b.sentAt);
    const lastMine = ordered.findLast((it) => it.mine);
    const desired: HTMLElement[] = [];
    let lastDay = '';
    ordered.forEach((item, i) => {
      const day = dayFmt.format(item.sentAt);
      if (day !== lastDay) {
        lastDay = day;
        const dayKey = `day:${day}`;
        let sep = nodes.get(dayKey);
        if (!sep) nodes.set(dayKey, (sep = h('div', { class: 'day' }, day)));
        desired.push(sep);
      }
      const prev = ordered[i - 1];
      const next = ordered[i + 1];
      const joins = (o?: Item) =>
        !!o && o.status !== 'tampered' && item.status !== 'tampered' && o.mine === item.mine &&
        Math.abs(o.sentAt - item.sentAt) < 5 * 60_000 && dayFmt.format(o.sentAt) === day;
      desired.push(bubbleFor(item, joins(prev), joins(next)));
      if (item === lastMine && (item.status === 'pending' || item.status === 'ok')) {
        status.textContent = item.status === 'pending' ? 'Sending…' : 'Delivered';
        status.dataset.status = item.status;
        status.title = item.status === 'ok' ? 'Stored on the relay. Your partner’s device picks it up from there.' : '';
        desired.push(status);
      }
    });

    if (desired.length === 0) {
      list.replaceChildren(
        h(
          'div',
          { class: 'chat-empty' },
          h('div', { class: 'hero-orb glass glass--clear', style: 'width:64px;height:64px;margin-bottom:14px' }, icon('shield')),
          'No messages yet. Everything you send here is encrypted with your pad before it leaves this device.',
        ),
      );
    } else {
      list.querySelector('.chat-empty')?.remove();
      // Keyed reconcile: only move nodes that are out of place, so existing
      // bubbles don't replay their entrance animation.
      desired.forEach((node, i) => {
        if (list.children[i] !== node) list.insertBefore(node, list.children[i] ?? null);
      });
      while (list.children.length > desired.length) list.lastElementChild!.remove();
    }
    if (forceScroll || nearBottom) list.scrollTop = list.scrollHeight;
    updateGauge();
  }

  // ----- menu & actions -----

  let menu: HTMLElement | null = null;
  function toggleMenu() {
    if (menu) return closeMenu();
    const item = (ic: Parameters<typeof icon>[0], label: string, fn: () => void, danger = false) =>
      h('button', { role: 'menuitem', class: danger ? 'btn--danger' : '', onclick: () => (closeMenu(), fn()) }, icon(ic), label);
    menu = h(
      'div',
      { class: 'menu glass glass--thick', role: 'menu' },
      item('edit', 'Rename', () => renameSheet(chat, async () => {
        chat = (await getChat(chatId)) ?? chat;
        nameEl.textContent = chat.name;
        const fresh = avatar(chat.name, chatId);
        av.replaceWith(fresh);
        av = fresh;
        cb.onChanged();
      })),
      item('link', 'Copy chat link', copyLink),
      chat.side === 0 && chat.partnerExported !== undefined
        ? item('download', 'Export partner copy', () => exportPartnerCopy(chat, pad))
        : null,
      h('hr'),
      item('trash', 'Delete from this device', () =>
        confirmSheet(
          'Delete this pad?',
          'The pad and chat are removed from this device. Without the pad, these messages can never be read here again. Your partner’s copy is not affected.',
          'Delete',
          async () => {
            await deleteChat(chatId);
            cb.onDeleted();
          },
        ),
      true),
    );
    menuAnchor.append(menu);
    moreBtn.setAttribute('aria-expanded', 'true');
    menu.querySelector('button')?.focus();
    setTimeout(() => document.addEventListener('pointerdown', outside), 0);
  }
  function outside(e: Event) {
    if (!menuAnchor.contains(e.target as Node)) closeMenu();
  }
  function closeMenu() {
    menu?.remove();
    menu = null;
    moreBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside);
  }

  async function copyLink() {
    const url = `${location.origin}/c/${chatId}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied. It only opens with the pad.');
    } catch {
      prompt('Copy this link', url);
    }
  }

  // ----- composer behaviour -----

  function autosize() {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    updateCost();
  }
  textarea.addEventListener('input', autosize);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  root.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());

  // ----- start -----

  draw();
  try {
    await backfill();
  } catch {
    toast('Couldn’t reach the relay. Retrying…');
  }
  draw(true);
  textarea.focus();

  const unsubscribe = subscribe(
    chatId,
    async (m) => {
      await ingest(m);
      draw();
      cb.onChanged();
    },
    () => void backfill(),
  );

  return () => {
    unsubscribe();
    spacing.disconnect();
    closeMenu();
  };
}
