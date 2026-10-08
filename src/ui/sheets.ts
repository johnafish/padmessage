import { claimChat, fetchMessages } from '../api.ts';
import { costOfCiphertext, open } from '../crypto/otp.ts';
import {
  checkRandomness,
  encodePadFile,
  fromBase64,
  generatePad,
  halfSize,
  identifyPad,
  MAX_PAD_BYTES,
  entropyId,
  parsePadFile,
  SIDE_NAMES,
  type PadSource,
  type Side,
} from '../crypto/pad.ts';
import { addChat, getChat, isEntropyUsed, updateChat, type ChatRecord } from '../store.ts';
import { download, formatBytes, h, icon, messagesLeft, sideIcon, SOURCE_INFO, sourceChip, toast } from './dom.ts';

// ---------- sheet scaffolding ----------

interface Sheet {
  body: HTMLElement;
  close: () => void;
}

function openSheet(label: string, onClose?: () => void): Sheet {
  const previousFocus = document.activeElement as HTMLElement | null;
  const body = h('div', { class: 'sheet glass glass--thick', role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
  const scrim = h('div', { class: 'scrim' }, body);
  const close = () => {
    scrim.remove();
    document.removeEventListener('keydown', onKey);
    previousFocus?.focus?.();
    onClose?.();
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  scrim.addEventListener('pointerdown', (e) => e.target === scrim && close());
  document.addEventListener('keydown', onKey);
  document.body.append(scrim);
  return { body, close };
}

function render(sheet: Sheet, ...children: (Node | false | null | undefined)[]) {
  sheet.body.replaceChildren(
    h(
      'button',
      { class: 'sheet-close btn btn--icon btn--sm glass glass--clear glass--pill glass--interactive', 'aria-label': 'Close', onclick: sheet.close },
      icon('close'),
    ),
    ...children.filter((c): c is Node => !!c),
  );
  sheet.body.querySelector<HTMLElement>('[autofocus]')?.focus();
}

function callout(tone: 'info' | 'warn' | 'danger', ...content: (Node | string)[]) {
  const ic = tone === 'info' ? 'info' : 'alert';
  return h('div', { class: `callout${tone === 'info' ? '' : ` callout--${tone}`}` }, icon(ic), h('div', null, ...content));
}

function sideChip(side: Side) {
  return h('span', { class: 'side-chip', 'data-side': side }, sideIcon(side), SIDE_NAMES[side]);
}

function fingerprintCard(fp: string, source?: PadSource) {
  return h(
    'div',
    { class: 'fp-card glass glass--clear' },
    h('small', null, 'Pad fingerprint'),
    h('div', { class: 'fingerprint fingerprint--big' }, fp),
    source && h('div', { style: 'margin-top: 10px' }, sourceChip(source)),
  );
}

function nameField(value = '') {
  const input = h('input', { type: 'text', placeholder: 'Who is this pad shared with?', maxlength: 60, autocomplete: 'off', value });
  return { input, el: h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Name'), h('div', { class: 'glass-well' }, input)) };
}

// ---------- new pad ----------

const SIZES = [
  { bytes: 1 * 1024 * 1024, label: '1 MB' },
  { bytes: 16 * 1024 * 1024, label: '16 MB' },
  { bytes: 64 * 1024 * 1024, label: '64 MB' },
];

export function newPadSheet(onDone: (chatId: string) => void) {
  const sheet = openSheet('Create a pad');
  let size = SIZES[0].bytes;
  let useHardware = false;
  let hardware: { bytes: Uint8Array; id: string; name: string } | null = null;
  const name = nameField();

  const sizeButtons = SIZES.map((s) =>
    h(
      'button',
      {
        class: 'choice glass glass--clear glass--interactive',
        'aria-pressed': String(s.bytes === size),
        onclick: () => {
          size = s.bytes;
          sync();
        },
      },
      h('b', null, s.label),
      h('span', null, `~${messagesLeft(halfSize(s.bytes))} msgs each`),
    ),
  );

  const sourceButtons = (['csprng', 'mixed'] as const).map((src) =>
    h(
      'button',
      {
        class: 'choice glass glass--clear glass--interactive',
        'aria-pressed': String(src === 'csprng'),
        onclick: () => {
          useHardware = src === 'mixed';
          sync();
        },
      },
      sourceChip(src),
      h('span', null, src === 'mixed' ? 'Hardware + browser' : 'Browser only'),
    ),
  );

  // Hardware randomness: raw bytes from a TRNG device, mixed in by XOR.
  const hwInput = h('input', { type: 'file', class: 'sr-only' });
  const hwStatus = h('div', { 'aria-live': 'polite' });
  const hwZone = h(
    'button',
    { class: 'dropzone', type: 'button', onclick: () => hwInput.click() },
    icon('upload'),
    h('div', null, h('b', null, 'Choose TRNG output'), ' or drop it here'),
    h('small', null, 'Raw bytes from a hardware random number generator, at least as large as the pad.'),
  );
  wireDrop(hwZone, (f) => void loadHardware(f));
  hwInput.addEventListener('change', () => hwInput.files?.[0] && void loadHardware(hwInput.files[0]));
  const hwSection = h(
    'div',
    { class: 'field', hidden: true },
    hwZone,
    hwInput,
    hwStatus,
    callout(
      'info',
      h('div', null, h('b', null, 'Linux'), ' with a hardware RNG: ', h('code', null, 'head -c 16777216 /dev/hwrng > trng.bin')),
      h(
        'div',
        { style: 'margin-top: 6px' },
        h('b', null, 'macOS'), ' has no ', h('code', null, '/dev/hwrng'), '. Plug in a USB TRNG such as an Infinite Noise: ',
        h('code', null, 'infnoise | head -c 16777216 > trng.bin'),
      ),
      h(
        'div',
        { style: 'margin-top: 6px' },
        'Don’t use ', h('code', null, '/dev/random'), ' or ', h('code', null, '/dev/urandom'),
        ': they’re software generators, the same kind your browser already uses. Each file can only be mixed into one pad.',
      ),
    ),
  );

  const sourceNote = h('div');
  const generate = h(
    'button',
    { class: 'btn btn--block glass glass--tinted glass--pill glass--interactive', onclick: () => void run() },
    icon('pad'),
    'Generate pad',
  );

  function sync() {
    sourceButtons.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 1) === useHardware)));
    hwSection.hidden = !useHardware;
    const limit = useHardware && hardware ? hardware.bytes.length : Infinity;
    if (size > limit) size = [...SIZES].reverse().find((s) => s.bytes <= limit)?.bytes ?? size;
    sizeButtons.forEach((b, i) => {
      b.setAttribute('aria-pressed', String(SIZES[i].bytes === size));
      b.disabled = SIZES[i].bytes > limit;
    });
    generate.disabled = useHardware && (!hardware || size > hardware.bytes.length);
    sourceNote.replaceChildren(
      useHardware
        ? callout('info', h('b', null, 'True random. '), SOURCE_INFO.mixed.detail)
        : callout('warn', h('b', null, 'Strong, but not provably unbreakable. '), SOURCE_INFO.csprng.detail),
    );
  }

  async function loadHardware(file: File) {
    hardware = null;
    sync();
    if (file.size > MAX_PAD_BYTES) {
      hwStatus.replaceChildren(callout('danger', `That file is over ${formatBytes(MAX_PAD_BYTES)}.`));
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length < SIZES[0].bytes) {
      hwStatus.replaceChildren(callout('danger', `Need at least ${SIZES[0].label} of hardware randomness; this file is ${formatBytes(bytes.length)}.`));
      return;
    }
    const randomness = checkRandomness(bytes);
    if (!randomness.ok) {
      hwStatus.replaceChildren(
        callout('danger', h('b', null, 'This doesn’t look random. '), 'Use your device’s whitened output, not raw samples. ', randomness.reason ?? ''),
      );
      return;
    }
    const id = await entropyId(bytes);
    if (await isEntropyUsed(id)) {
      hwStatus.replaceChildren(
        callout('danger', h('b', null, 'Already used. '), 'This file was mixed into another pad on this device. Reusing it would tie the two pads together. Capture fresh output.'),
      );
      return;
    }
    hardware = { bytes, id, name: file.name };
    hwStatus.replaceChildren(
      callout('info', h('b', null, `${formatBytes(bytes.length)} loaded`), ` from ${file.name}. Sizes up to that are available. Delete the file once the pad is made.`),
    );
    sync();
  }

  render(
    sheet,
    h('h2', null, 'Create a pad'),
    h('p', { class: 'lede' }, 'You keep one copy of the pad and hand the other to your partner in person.'),
    name.el,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Randomness'), h('div', { class: 'choices choices--2' }, ...sourceButtons)),
    hwSection,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Pad size'), h('div', { class: 'choices' }, ...sizeButtons)),
    sourceNote,
    h('div', { class: 'sheet-foot' }, generate),
  );
  sync();
  name.input.focus();

  async function run() {
    const source: PadSource = useHardware ? 'mixed' : 'csprng';
    if (useHardware && !hardware) return;
    generate.disabled = true;
    generate.lastChild!.textContent = 'Generating…';
    await new Promise((r) => setTimeout(r, 30)); // let the label paint before the CPU-bound work
    const body = generatePad(size, useHardware ? hardware!.bytes : undefined);
    const { chatId, fingerprint, writeKey } = await identifyPad(body);
    try {
      await claimChat(chatId, writeKey);
    } catch (err) {
      generate.disabled = false;
      generate.lastChild!.textContent = 'Generate pad';
      toast(`Couldn’t reach the relay: ${err instanceof Error ? err.message : err}`);
      return;
    }
    const now = Date.now();
    const chat: ChatRecord = {
      chatId,
      fingerprint,
      writeKey,
      name: name.input.value.trim() || 'New pad',
      side: 0,
      padLength: body.length,
      half: halfSize(body.length),
      sendOffset: 0,
      sentOffsets: [],
      historyFloor: 0,
      createdAt: now,
      lastActivity: now,
      partnerExported: false,
      source,
    };
    await addChat(chat, body, useHardware ? hardware!.id : undefined);
    hardware = null; // drop our reference to the raw TRNG bytes
    showHandoff(sheet, chat, body, () => {
      sheet.close();
      onDone(chatId);
    });
  }
}

function wireDrop(zone: HTMLElement, onFile: (f: File) => void) {
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.dataset.over = 'true';
  });
  zone.addEventListener('dragleave', () => delete zone.dataset.over);
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    delete zone.dataset.over;
    const file = e.dataTransfer?.files[0];
    if (file) onFile(file);
  });
}

function showHandoff(sheet: Sheet, chat: ChatRecord, body: Uint8Array, onOpen: () => void) {
  const partner: Side = chat.side === 0 ? 1 : 0;
  const openBtn = h(
    'button',
    { class: 'btn glass glass--tinted glass--pill glass--interactive', onclick: onOpen, disabled: !chat.partnerExported },
    'Open chat',
  );
  const save = h(
    'button',
    {
      class: 'btn glass glass--pill glass--interactive',
      autofocus: true,
      onclick: async () => {
        download(encodePadFile(body, partner, chat.source ?? 'external'), `${slug(chat.name)}-${SIDE_NAMES[partner].toLowerCase()}.pad`);
        await updateChat(chat.chatId, { partnerExported: true });
        openBtn.disabled = false;
      },
    },
    icon('download'),
    'Save partner copy',
  );
  render(
    sheet,
    h('h2', null, 'Pad ready'),
    h('p', { class: 'lede' }, 'You are ', sideChip(chat.side), '. Your partner’s copy is marked ', sideChip(partner), ' so you never use the same bytes.'),
    fingerprintCard(chat.fingerprint, chat.source),
    callout(
      'warn',
      h('b', null, 'Hand it over in person. '),
      'Use AirDrop, a USB stick or a cable. Never email, message or upload a pad: anyone who copies it can read every message. Delete the file from the transfer device afterwards.',
    ),
    callout('info', 'When you meet, check that both screens show the same fingerprint.'),
    h('div', { class: 'sheet-foot' }, save, openBtn),
  );
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pad';
}

export function exportPartnerCopy(chat: ChatRecord, body: Uint8Array) {
  const sheet = openSheet('Export partner copy');
  showHandoff(sheet, { ...chat, partnerExported: true }, body, sheet.close);
}

// ---------- import ----------

interface ImportOptions {
  /** Set when arriving from a share link: the pad must unlock this chat. */
  expectChatId?: string;
}

export function importPadSheet(onDone: (chatId: string) => void, opts: ImportOptions = {}) {
  const sheet = openSheet('Load a pad');
  const fileInput = h('input', { type: 'file', class: 'sr-only', accept: '.pad,application/octet-stream,*/*' });
  const status = h('div', { 'aria-live': 'polite' });
  const zone = h(
    'button',
    { class: 'dropzone', type: 'button', onclick: () => fileInput.click(), autofocus: true },
    icon('upload'),
    h('div', null, h('b', null, 'Choose a pad file'), ' or drop it here'),
    h('small', null, 'It stays on this device. Nothing is uploaded.'),
  );
  wireDrop(zone, (f) => void read(f));
  fileInput.addEventListener('change', () => fileInput.files?.[0] && void read(fileInput.files[0]));

  render(
    sheet,
    h('h2', null, opts.expectChatId ? 'Unlock this chat' : 'Load a pad'),
    h(
      'p',
      { class: 'lede' },
      opts.expectChatId
        ? 'Load the pad file your partner gave you. Only the matching pad can open this chat.'
        : 'Load a pad file from your partner, or one you made with your own random number generator.',
    ),
    zone,
    fileInput,
    status,
  );

  async function read(file: File) {
    if (file.size > MAX_PAD_BYTES + 16) {
      status.replaceChildren(callout('danger', `That file is over ${formatBytes(MAX_PAD_BYTES)}, which is too large for a browser pad.`));
      return;
    }
    status.replaceChildren(h('div', { class: 'progress' }, h('i', { style: '--p: 60%' })));
    const parsed = parsePadFile(new Uint8Array(await file.arrayBuffer()));
    const randomness = checkRandomness(parsed.body);
    if (!randomness.ok) {
      status.replaceChildren(callout('danger', h('b', null, 'This doesn’t look like a pad. '), randomness.reason ?? ''));
      return;
    }
    const { chatId, fingerprint, writeKey } = await identifyPad(parsed.body);
    if (opts.expectChatId && chatId !== opts.expectChatId) {
      status.replaceChildren(callout('danger', h('b', null, 'Wrong pad. '), 'This pad does not unlock this chat. Check you have the file for this conversation.'));
      return;
    }
    if (await getChat(chatId)) {
      sheet.close();
      toast('That pad is already on this device');
      onDone(chatId);
      return;
    }
    confirm(parsed.body, parsed.side, parsed.source, chatId, fingerprint, writeKey, file.name);
  }

  function confirm(body: Uint8Array, presetSide: Side | null, source: PadSource, chatId: string, fingerprint: string, writeKey: string, filename: string) {
    let side: Side | null = presetSide;
    const name = nameField(filename.replace(/\.pad$/i, '').replace(/-(sun|moon)$/i, '').replace(/[-_]+/g, ' ').trim());
    const go = h(
      'button',
      { class: 'btn glass glass--tinted glass--pill glass--interactive', disabled: side === null, onclick: () => void save() },
      icon('lock'),
      'Load pad',
    );
    const error = h('div', { 'aria-live': 'polite' });

    let sidePicker: HTMLElement | null = null;
    if (presetSide === null) {
      const buttons = ([0, 1] as const).map((s) =>
        h(
          'button',
          {
            class: 'choice glass glass--clear glass--interactive',
            'aria-pressed': 'false',
            onclick: () => {
              side = s;
              buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(i === s)));
              go.disabled = false;
            },
          },
          sideChip(s),
          h('span', null, s === 0 ? 'First half of the pad' : 'Second half of the pad'),
        ),
      );
      sidePicker = h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label' }, 'Your side'),
        h('div', { class: 'choices choices--2' }, ...buttons),
        callout('warn', 'This file has no side marked. ', h('b', null, 'Agree with your partner'), ' that one of you is Sun and the other is Moon. If you both pick the same side, messages can be broken.'),
      );
    }

    render(
      sheet,
      h('h2', null, 'Check the fingerprint'),
      h('p', { class: 'lede' }, `${formatBytes(body.length)} pad · ${messagesLeft(halfSize(body.length))} messages each way. Compare this with your partner’s screen.`),
      fingerprintCard(fingerprint, source),
      presetSide !== null && h('p', { class: 'lede' }, 'This copy is marked ', sideChip(presetSide), '.'),
      source === 'external' &&
        callout('warn', h('b', null, 'Unverified randomness. '), SOURCE_INFO.external.detail),
      h('div', { style: 'height: 12px' }),
      name.el,
      sidePicker,
      error,
      h('div', { class: 'sheet-foot' }, go),
    );

    async function save() {
      if (side === null) return;
      go.disabled = true;
      try {
        await claimChat(chatId, writeKey);
        // Skip past any bytes this side already spent, in case this pad was
        // loaded before on another device or an earlier install.
        const existing = await fetchMessages(chatId);
        // Only authenticated messages count, so junk posted to the chat can't burn the pad.
        let floor = 0;
        for (const m of existing) {
          if (m.side !== side) continue;
          const sealed = { side, offset: m.offset, ct: fromBase64(m.ct), tag: fromBase64(m.tag) };
          try {
            open(body, chatId, sealed);
            floor = Math.max(floor, m.offset + costOfCiphertext(sealed.ct.length));
          } catch {
            /* forged or corrupt: ignore */
          }
        }
        const now = Date.now();
        await addChat(
          {
            chatId,
            fingerprint,
            writeKey,
            name: name.input.value.trim() || 'Imported pad',
            side,
            padLength: body.length,
            half: halfSize(body.length),
            sendOffset: floor,
            sentOffsets: [],
            historyFloor: floor,
            createdAt: now,
            lastActivity: now,
            source,
          },
          body,
        );
        sheet.close();
        onDone(chatId);
      } catch (err) {
        go.disabled = false;
        error.replaceChildren(callout('danger', `Couldn’t load the pad: ${err instanceof Error ? err.message : err}`));
      }
    }
  }
}

// ---------- rename / delete ----------

export function renameSheet(chat: ChatRecord, onDone: () => void) {
  const sheet = openSheet('Rename');
  const name = nameField(chat.name);
  const save = async () => {
    await updateChat(chat.chatId, { name: name.input.value.trim() || chat.name });
    sheet.close();
    onDone();
  };
  name.input.addEventListener('keydown', (e) => e.key === 'Enter' && void save());
  render(
    sheet,
    h('h2', null, 'Rename chat'),
    h('p', { class: 'lede' }, 'Names are stored only on this device.'),
    name.el,
    h('div', { class: 'sheet-foot' }, h('button', { class: 'btn glass glass--tinted glass--pill glass--interactive', onclick: save }, 'Save')),
  );
  name.input.focus();
  name.input.select();
}

export function confirmSheet(title: string, text: string, action: string, onConfirm: () => void) {
  const sheet = openSheet(title);
  render(
    sheet,
    h('h2', null, title),
    h('p', { class: 'lede' }, text),
    h(
      'div',
      { class: 'sheet-foot' },
      h('button', { class: 'btn glass glass--pill glass--interactive', onclick: sheet.close, autofocus: true }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn btn--danger glass glass--pill glass--interactive',
          onclick: () => {
            sheet.close();
            onConfirm();
          },
        },
        icon('trash'),
        action,
      ),
    ),
  );
}
