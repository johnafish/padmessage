import { fetchMessages, postMessage, type WireMessage } from '../api.ts';
import {
  costOfCiphertext,
  costOfContent,
  frame,
  MAX_FRAME_BYTES,
  MAX_TEXT_CHARS,
  open,
  seal,
  unframe,
  type Content,
} from '../crypto/otp.ts';
import { fromBase64, toBase64, type Side } from '../crypto/pad.ts';
import { deleteChat, getChat, getPad, PadExhaustedError, reserve } from '../store.ts';
import { avatar, formatBytes, h, icon, messagesLeft, sourceChip, toast } from './dom.ts';
import { prepareImage, type ImageOption } from './images.ts';
import { confirmSheet, exportPartnerCopy, renameSheet } from './sheets.ts';
import { onMessage, onResync } from '../sync.ts';

interface Item {
  /** `${side}:${offset}`: unique, since a side never reuses an offset. */
  key: string;
  seq: number; // Infinity while pending
  mine: boolean;
  /** tampered: failed authentication. unsupported: authentic, but a format this version can't show. */
  status: 'ok' | 'pending' | 'failed' | 'tampered' | 'unsupported';
  content: Content | null;
  sentAt: number;
}

interface Attachment {
  options: ImageOption[];
  choice: number;
  thumb: string;
}

export interface ChatCallbacks {
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  /** The user has now seen messages up to this seq. */
  onRead: (seq: number) => void;
}

export async function mountChat(container: HTMLElement, chatId: string, cb: ChatCallbacks): Promise<() => void> {
  let chat = (await getChat(chatId))!;
  const pad = (await getPad(chatId))!;
  const sentOffsets = new Set(chat.sentOffsets);
  const highWater: [number, number] = [0, 0];
  const items = new Map<string, Item>();
  const nodes = new Map<string, HTMLElement>();
  const imageUrls = new Map<string, string>();
  let lastSeq = 0;
  let collision = false;
  let attachment: Attachment | null = null;
  let preparing = false;
  let reserving = false;

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

  // Composer: one bar holding [attach] [text] [cost] [send], with an
  // attachment tray above the row when a photo is attached.
  const fileInput = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const attachBtn = h(
    'button',
    { class: 'composer-attach glass--interactive', 'aria-label': 'Attach a photo', title: 'Attach a photo', onclick: () => fileInput.click() },
    icon('image'),
  );
  const textarea = h('textarea', { rows: 1, placeholder: 'Message', maxlength: MAX_TEXT_CHARS, 'aria-label': 'Message' });
  const hint = h('span', { class: 'composer-hint', 'aria-live': 'polite' });
  const sendBtn = h(
    'button',
    { class: 'send glass glass--tinted glass--pill glass--interactive', 'aria-label': 'Send', disabled: true, onclick: () => void send() },
    icon('send'),
  );
  const tray = h('div', { class: 'composer-tray', hidden: true });
  const composer = h(
    'div',
    { class: 'composer glass glass--track' },
    tray,
    h('div', { class: 'composer-row' }, attachBtn, textarea, hint, sendBtn),
    fileInput,
  );

  const root = h('section', { class: 'chat' }, head, banner, list, composer);
  container.replaceChildren(root);

  // The header and composer float over the list and change height (header
  // compaction, a multi-line draft, the attachment tray), so the list's
  // padding tracks them.
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
    updateComposer();
  }

  // ----- composer -----

  function imageContent(option: ImageOption, caption: string): Content {
    return { kind: 'image', mime: option.mime, width: option.width, height: option.height, data: option.data, caption };
  }

  function draft(): Content | null {
    const text = textarea.value.trim();
    if (attachment) return imageContent(attachment.options[attachment.choice], text);
    return text ? { kind: 'text', text } : null;
  }

  /** Cost hint and send state. The hint only appears when it says something. */
  function updateComposer() {
    const left = remaining();
    const content = draft();
    const need = content ? costOfContent(content) : 0;
    let text = '';
    let tone = '';
    if (preparing) text = 'Preparing…';
    else if (content && need > left) [text, tone] = ['Not enough pad', 'danger'];
    else if (content && need > MAX_FRAME_BYTES) [text, tone] = ['Too large', 'danger'];
    else if (content) [text, tone] = [formatBytes(need), left / chat.half < 0.1 ? 'warn' : ''];
    else if (left / chat.half < 0.1) [text, tone] = [`${formatBytes(left)} left`, 'warn'];
    hint.textContent = text;
    hint.dataset.tone = tone;
    hint.title = content ? `Uses ${formatBytes(need)} of pad. ${formatBytes(left)} left in your half.` : `${formatBytes(left)} of pad left in your half.`;
    sendBtn.disabled = !content || need > left || need > MAX_FRAME_BYTES || collision || preparing;
    if (attachment) renderTrayChoices();
  }

  async function attach(file: File) {
    if (file.type && !file.type.startsWith('image/')) return toast('Only images can be attached.');
    clearAttachment();
    preparing = true;
    tray.hidden = false;
    tray.replaceChildren(h('div', { class: 'tray-thumb tray-thumb--loading' }), h('div', { class: 'tray-body' }, h('div', { class: 'tray-note' }, 'Preparing photo…')));
    updateComposer();
    try {
      const options = await prepareImage(file);
      const left = remaining();
      const costs = options.map((o) => costOfContent(imageContent(o, '')));
      // Default to the largest size that spends at most a quarter of what's
      // left, else the smallest that fits at all.
      let choice = costs.findLastIndex((c) => c <= left / 4);
      if (choice < 0) choice = Math.max(0, costs.findIndex((c) => c <= left));
      attachment = { options, choice, thumb: URL.createObjectURL(new Blob([options[0].data as BlobPart], { type: options[0].mime })) };
      renderTray();
    } catch (err) {
      tray.hidden = true;
      toast(err instanceof Error ? err.message : 'Couldn’t attach that image.');
    } finally {
      preparing = false;
      updateComposer();
      textarea.focus();
    }
  }

  function clearAttachment() {
    if (attachment) URL.revokeObjectURL(attachment.thumb);
    attachment = null;
    tray.hidden = true;
    tray.replaceChildren();
  }

  const trayChoices = h('div', { class: 'tray-choices', role: 'radiogroup', 'aria-label': 'Photo size' });

  function renderTray() {
    if (!attachment) return;
    tray.hidden = false;
    tray.replaceChildren(
      h('img', { class: 'tray-thumb', src: attachment.thumb, alt: 'Attached photo' }),
      h('div', { class: 'tray-body' }, trayChoices, h('div', { class: 'tray-note' }, 'Location and camera details are removed.')),
      h(
        'button',
        {
          class: 'tray-remove glass--interactive',
          'aria-label': 'Remove photo',
          onclick: () => {
            clearAttachment();
            updateComposer();
            textarea.focus();
          },
        },
        icon('close'),
      ),
    );
    renderTrayChoices();
  }

  function renderTrayChoices() {
    if (!attachment) return;
    const a = attachment;
    const left = remaining();
    const caption = textarea.value.trim();
    trayChoices.replaceChildren(
      ...a.options.map((o, i) => {
        const cost = costOfContent(imageContent(o, caption));
        return h(
          'button',
          {
            class: 'tray-choice',
            role: 'radio',
            'aria-checked': String(i === a.choice),
            disabled: cost > left || cost > MAX_FRAME_BYTES,
            title: `${o.width}×${o.height}`,
            onclick: () => {
              a.choice = i;
              updateComposer();
            },
          },
          h('b', null, o.label),
          ` ${formatBytes(cost)}`,
        );
      }),
    );
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void attach(file);
  });
  textarea.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      void attach(file);
    }
  });
  // Drop a photo anywhere on the chat.
  root.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault();
    root.dataset.drop = 'true';
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget as Node | null)) delete root.dataset.drop;
  });
  root.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    delete root.dataset.drop;
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) void attach(file);
    else toast('Only images can be attached.');
  });

  // ----- receiving -----

  /** Takes a full message (with ciphertext); stubs are fetched first, see the stream listener. */
  async function ingest(wire: WireMessage) {
    if (!wire.ct) return;
    lastSeq = Math.max(lastSeq, wire.seq);
    const side = wire.side as Side;
    const key = `${side}:${wire.offset}`;
    const ct = fromBase64(wire.ct);
    const mine = side === chat.side;

    let plain: Uint8Array;
    try {
      plain = open(pad, chatId, { side, offset: wire.offset, ct, tag: fromBase64(wire.tag) });
    } catch {
      // Forged or corrupt. It never counts toward pad usage, so junk can't burn the pad.
      items.set(key, { key, seq: wire.seq, mine: false, status: 'tampered', content: null, sentAt: wire.receivedAt });
      return;
    }
    highWater[side] = Math.max(highWater[side], wire.offset + costOfCiphertext(ct.length));

    if (mine && wire.offset >= chat.historyFloor && !sentOffsets.has(wire.offset)) {
      // Another tab on this device may have sent it; check the stored record before alarming.
      chat = (await getChat(chatId)) ?? chat;
      chat.sentOffsets.forEach((o) => sentOffsets.add(o));
      if (!sentOffsets.has(wire.offset)) flagCollision();
    }
    try {
      const { content, sentAt } = unframe(plain);
      items.set(key, { key, seq: wire.seq, mine, status: 'ok', content, sentAt });
    } catch {
      items.set(key, { key, seq: wire.seq, mine, status: 'unsupported', content: null, sentAt: wire.receivedAt });
    }
  }

  function flagCollision() {
    if (collision) return;
    collision = true;
    banner.hidden = false;
    banner.replaceChildren(
      h('b', null, 'Someone else is using your half of the pad. '),
      'Messages are arriving from your half that this device didn’t send. Your partner may have picked the same half, or the pad was copied. Sending is paused to protect the pad. Exchange a new pad.',
    );
    updateComposer();
  }

  async function backfill() {
    const fresh = await fetchMessages(chatId, lastSeq);
    for (const m of fresh) await ingest(m);
    draw();
  }

  // ----- sending -----

  async function send() {
    const content = draft();
    if (!content || collision || preparing || reserving) return;
    await sendContent(content, () => {
      textarea.value = '';
      clearAttachment();
      autosize();
    });
  }

  /** Reserves pad bytes, then encrypts and posts. `onReserved` clears the draft once the bytes are claimed. */
  async function sendContent(content: Content, onReserved?: () => void) {
    const need = costOfContent(content);
    let offset: number;
    reserving = true;
    try {
      offset = await reserve(chatId, need, highWater[chat.side]);
    } catch (err) {
      toast(err instanceof PadExhaustedError ? err.message : 'Couldn’t reserve pad bytes');
      return;
    } finally {
      reserving = false;
    }
    onReserved?.();
    sentOffsets.add(offset);
    chat = { ...chat, sendOffset: offset + need };

    const sentAt = Date.now();
    const key = `${chat.side}:${offset}`;
    items.set(key, { key, seq: Infinity, mine: true, status: 'pending', content, sentAt });
    draw(true);

    const sealed = seal(pad, chatId, chat.side, offset, frame(content, sentAt));
    try {
      const wire = await postMessage(chatId, chat.writeKey, { side: chat.side, offset, ct: toBase64(sealed.ct), tag: toBase64(sealed.tag) });
      if (items.get(key)?.status !== 'ok') items.set(key, { key, seq: wire.seq, mine: true, status: 'ok', content, sentAt });
      highWater[chat.side] = Math.max(highWater[chat.side], offset + need);
      lastSeq = Math.max(lastSeq, wire.seq);
    } catch (err) {
      console.warn('send failed', err);
      items.set(key, { key, seq: Infinity, mine: true, status: 'failed', content, sentAt });
    }
    draw();
    cb.onChanged();
  }

  /** Resends with fresh pad bytes; the failed attempt's bytes stay burned. */
  function retry(item: Item) {
    if (!item.content) return;
    items.delete(item.key);
    draw();
    void sendContent(item.content);
  }

  // ----- rendering -----

  const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

  function imageUrl(item: Item, content: Extract<Content, { kind: 'image' }>): string {
    let url = imageUrls.get(item.key);
    if (!url) imageUrls.set(item.key, (url = URL.createObjectURL(new Blob([content.data as BlobPart], { type: content.mime }))));
    return url;
  }

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
    if (item.status === 'tampered' || item.status === 'unsupported' || !item.content) {
      return h(
        'div',
        { class: 'bubble bubble--alert glass glass--tinted' },
        item.status === 'unsupported'
          ? [h('b', null, 'Can’t show this message. '), 'It’s in a format this version of PadMessage doesn’t support.']
          : [h('b', null, 'A message failed verification. '), 'It was changed in transit or wasn’t made with this pad, so it was discarded.'],
      );
    }
    const content = item.content;
    const meta = h('div', { class: 'bubble-meta' }, timeFmt.format(item.sentAt));
    const classes = [
      'bubble',
      item.mine ? 'bubble--mine glass glass--tinted' : 'bubble--theirs glass',
      content.kind === 'image' ? 'bubble--image' : '',
      item.status === 'pending' ? 'bubble--pending' : '',
      item.status === 'failed' ? 'bubble--failed' : '',
    ];
    const body: (Node | string)[] = [];
    if (content.kind === 'text') {
      body.push(content.text);
    } else {
      const url = imageUrl(item, content);
      const alt = content.caption || 'Photo';
      body.push(
        h(
          'button',
          { class: 'bubble-image', 'aria-label': 'View photo', onclick: () => openLightbox(url, content, item.sentAt) },
          h('img', { src: url, alt, width: content.width, height: content.height, decoding: 'async' }),
        ),
      );
      if (content.caption) body.push(h('div', { class: 'bubble-caption' }, content.caption));
    }
    const el = h('div', { class: classes.filter(Boolean).join(' ') }, ...body, meta);
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

  function openLightbox(url: string, content: Extract<Content, { kind: 'image' }>, sentAt: number) {
    const previousFocus = document.activeElement as HTMLElement | null;
    const close = () => {
      box.remove();
      document.removeEventListener('keydown', onKey);
      previousFocus?.focus?.();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const ext = content.mime === 'image/webp' ? 'webp' : 'jpg';
    const name = `padmessage-${new Date(sentAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
    const closeBtn = h('button', { class: 'btn btn--icon glass glass--pill glass--interactive', 'aria-label': 'Close', onclick: close }, icon('close'));
    const box = h(
      'div',
      { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': content.caption || 'Photo' },
      h(
        'div',
        { class: 'lightbox-bar' },
        h('a', { class: 'btn btn--sm glass glass--pill glass--interactive', href: url, download: name }, icon('download'), 'Save'),
        closeBtn,
      ),
      h('img', { src: url, alt: content.caption || 'Photo' }),
      content.caption && h('div', { class: 'lightbox-caption' }, content.caption),
    );
    box.addEventListener('pointerdown', (e) => e.target === box && close());
    document.addEventListener('keydown', onKey);
    document.body.append(box);
    closeBtn.focus();
  }

  // Delivery status sits under your latest message only, as in most messengers.
  // "Delivered" means the relay has stored it: it answers a send only after the
  // write, and our own messages echo back over the stream only after it too.
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
        !!o && !!o.content && !!item.content && o.mine === item.mine &&
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
    reportRead();
  }

  /** Everything rendered counts as read, but only while the user can actually see it. */
  function reportRead() {
    if (document.visibilityState !== 'visible') return;
    let seen = 0;
    for (const item of items.values()) if (Number.isFinite(item.seq)) seen = Math.max(seen, item.seq);
    if (seen > 0) cb.onRead(seen);
  }
  document.addEventListener('visibilitychange', reportRead);

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
    updateComposer();
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

  // Messages are ingested strictly in arrival order: ingest is async (it may
  // re-read the chat record), and history must not interleave with live events.
  let queue = Promise.resolve();
  const enqueue = (task: () => Promise<void>) => {
    queue = queue.then(task).catch((err) => console.warn('update failed', err));
  };
  // Listen before loading history, so nothing arriving meanwhile is missed;
  // the queue applies it after the history, and ingest ignores duplicates.
  const stopMessages = onMessage((m) => {
    if (m.chatId !== chatId) return;
    enqueue(async () => {
      // Photos arrive on the stream as stubs; fetch the full message.
      if (m.ct) await ingest(m);
      else await backfill();
      draw();
      cb.onChanged();
    });
  });
  const stopResync = onResync(() => enqueue(backfill));

  draw();
  enqueue(async () => {
    try {
      await backfill();
    } catch {
      toast('Couldn’t reach the relay. Retrying…');
    }
    draw(true);
  });
  await queue;
  textarea.focus();

  return () => {
    stopMessages();
    stopResync();
    document.removeEventListener('visibilitychange', reportRead);
    spacing.disconnect();
    closeMenu();
    clearAttachment();
    for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  };
}
