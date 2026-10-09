// Fits the app to the part of the screen the user can actually see.
//
// When the on-screen keyboard opens, phones shrink the *visual* viewport.
// iOS Safari leaves the layout (and 100dvh) at full height and scrolls the
// page to reveal the focused field, which drags the header off-screen and
// leaves the layout jumping. So the app follows the visual viewport itself:
// its height and offset become --vvh / --vvtop, which the app shell, sheets
// and toasts are positioned with. The result matches native messengers:
// header pinned, message bar sitting directly on the keyboard. Android
// Chrome resizes natively (interactive-widget=resizes-content in the
// viewport meta tag); tracking on top of that is harmless.

export function trackVisualViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  const touch = matchMedia('(pointer: coarse)');
  let fullHeight = 0;
  let width = 0;
  let frame = 0;

  const apply = () => {
    frame = 0;
    // Pinch-zooming also shrinks the visible area; leave the layout alone then.
    if (vv.scale > 1.01) return;
    // A new width means rotation or a resized window: measure afresh.
    if (vv.width !== width) [width, fullHeight] = [vv.width, 0];
    fullHeight = Math.max(fullHeight, vv.height);
    root.style.setProperty('--vvh', `${vv.height}px`);
    root.style.setProperty('--vvtop', `${vv.offsetTop}px`);
    // Much shorter than the tallest we've seen at this width: a keyboard is up.
    // (Browser toolbars collapsing change the height by far less.)
    root.classList.toggle('keyboard-open', touch.matches && fullHeight - vv.height > 120);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
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
