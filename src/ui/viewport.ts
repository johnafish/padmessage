// Fits the app to the part of the screen the user can actually see.
//
// When the on-screen keyboard opens, phones shrink the *visual* viewport.
// iOS Safari leaves the layout (and 100dvh) at full height and scrolls the
// page to reveal the focused field, which drags the header off-screen and
// leaves the layout jumping. So the app follows the visual viewport itself:
// its height and offset become --vvh / --vvtop, which the app shell, sheets
// and toasts are positioned with. Android Chrome resizes natively
// (interactive-widget=resizes-content in the viewport meta tag); tracking on
// top of that is harmless.
//
// iOS Safari also reports the keyboard only once it has finished animating
// in, and slides the page up in the meantime, so purely following it leaves
// the app out of place for the length of the animation (a visible blink).
// On iPhone and iPad the app therefore *predicts* the keyboard: the moment a
// text field gains focus it shrinks by the keyboard's height (remembered
// from last time, estimated the first time). It does so instantly, not
// animated: Safari decides whether to scroll from the field's position at
// the moment of focus, so the field must already be clear of the keyboard
// then. Safari then has nothing to scroll, and the real measurement corrects
// any difference. Closing is predicted too, and animated with the keyboard.

const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
/**
 * First-time keyboard estimate, as a share of the screen. An iPhone keyboard
 * plus Safari's form bar is about 45% of the screen; erring high means the
 * bar settles down a few pixels, erring low would let Safari scroll.
 */
const KEYBOARD_GUESS = 0.46;
const KEYBOARD_KEY = 'padmessage:keyboard-height';
/** If Safari hasn't reported the predicted change by then, there was no keyboard (e.g. a hardware one is attached). */
const PREDICTION_TIMEOUT_MS = 900;

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && /^(text|search|email|url|tel|password|number)$/.test((el as HTMLInputElement).type);
}

function readHeight(): number {
  try {
    return Number(localStorage.getItem(KEYBOARD_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeHeight(h: number) {
  try {
    localStorage.setItem(KEYBOARD_KEY, String(Math.round(h)));
  } catch {
    /* private mode etc.: we'll estimate again next time */
  }
}

export function trackVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const touch = matchMedia('(pointer: coarse)');
  let fullHeight = 0;
  let width = 0;
  let remembered = readHeight();
  /** A predicted height to hold until Safari reports the keyboard as `until`. */
  let target: { height: number; until: 'up' | 'down' } | null = null;
  let targetTimer: ReturnType<typeof setTimeout> | undefined;
  let movingTimer: ReturnType<typeof setTimeout> | undefined;
  let last = '';

  const keyboardUp = () => touch.matches && fullHeight - vv.height > 120;

  const apply = () => {
    // Pinch-zooming also shrinks the visible area; leave the layout alone then.
    if (vv.scale > 1.01) return;
    // A new width means rotation or a resized window: measure afresh.
    if (vv.width !== width) [width, fullHeight] = [vv.width, 0];
    fullHeight = Math.max(fullHeight, vv.height);
    const up = keyboardUp();
    if (target && (target.until === 'up') === up) {
      // Safari has caught up with the prediction. If the first-time estimate
      // was off, glide to the real size (Safari has already decided by now).
      if (target.until === 'up' && Math.abs(target.height - vv.height) > 2) {
        root.classList.add('keyboard-moving');
        clearTimeout(movingTimer);
        movingTimer = setTimeout(() => root.classList.remove('keyboard-moving'), 500);
      }
      target = null;
      clearTimeout(targetTimer);
    }
    if (up) {
      const kb = fullHeight - vv.height;
      if (Math.abs(kb - remembered) > 1 && kb > 150 && kb < fullHeight * 0.7) writeHeight((remembered = kb));
    }
    const height = target?.height ?? vv.height;
    const state = `${height}|${vv.offsetTop}|${target ? target.until === 'up' : up}`;
    if (state === last) return;
    last = state;
    root.style.setProperty('--vvh', `${height}px`);
    root.style.setProperty('--vvtop', `${vv.offsetTop}px`);
    // The keyboard covers the home indicator, so its safe-area gap goes (CSS).
    root.classList.toggle('keyboard-open', target ? target.until === 'up' : up);
  };

  // Follow every frame for a moment after anything changes, so a scroll
  // Safari makes between events is matched within a frame.
  let watchUntil = 0;
  const watch = () => {
    const idle = performance.now() > watchUntil;
    watchUntil = performance.now() + 1000;
    if (!idle) return;
    const loop = () => {
      apply();
      if (performance.now() < watchUntil) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  };

  const predict = (height: number, until: 'up' | 'down') => {
    target = { height, until };
    clearTimeout(targetTimer);
    targetTimer = setTimeout(() => {
      target = null;
      apply();
    }, PREDICTION_TIMEOUT_MS);
    // Closing is animated in step with the keyboard (CSS: .keyboard-moving).
    // Opening is not: the field has to be clear of the keyboard at once.
    clearTimeout(movingTimer);
    root.classList.toggle('keyboard-moving', until === 'down');
    if (until === 'down') movingTimer = setTimeout(() => root.classList.remove('keyboard-moving'), 500);
    apply();
    watch();
  };

  if (IOS) {
    document.addEventListener('focusin', (e) => {
      if (!touch.matches || keyboardUp() || target?.until === 'up' || !isTextEntry(e.target as Element)) return;
      const keyboard = remembered || Math.round(fullHeight * KEYBOARD_GUESS);
      predict(Math.max(200, fullHeight - keyboard), 'up');
    });
    document.addEventListener('focusout', () => {
      // Deferred: focus may be moving straight to another field.
      setTimeout(() => {
        if (isTextEntry(document.activeElement)) return;
        // Only when Safari hasn't slid the page; otherwise just follow it.
        if (vv.offsetTop < 1 && (keyboardUp() || target?.until === 'up')) predict(fullHeight, 'down');
      });
    });
  }

  const onChange = () => {
    apply();
    watch();
  };
  vv.addEventListener('resize', onChange);
  vv.addEventListener('scroll', onChange);
  apply();
}

/**
 * Whether to focus text fields automatically. With a mouse it saves a
 * click; on a phone it pops up the keyboard uninvited, which native apps
 * never do.
 */
export function autofocusFields(): boolean {
  return matchMedia('(hover: hover) and (pointer: fine)').matches;
}
