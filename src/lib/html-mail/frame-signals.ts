/**
 * The app's way to see what happens inside the message frame without running
 * code there (ADR 0006 decision 9, implementation record 12).
 *
 * The frame has `sandbox="allow-same-origin"` and no `allow-scripts`. Chromium
 * still runs listeners the app adds to the frame's nodes; WebKit runs none of
 * them, whichever realm the function belongs to. On WebKit the app instead
 * reads state that the user agent changes without script:
 *
 * - **Links** get `href="about:srcdoc#<nonce>-<i>"`. Activating one (click,
 *   tap, Enter) is a same-document fragment navigation: nothing is fetched and
 *   nothing scrolls, because its target is a `display: none` element. The
 *   target makes `eos-target:target ~ eos-signal` match, the signal element
 *   gets a width, and the app's ResizeObserver reads the fragment, resets it
 *   and asks for confirmation as it does on Chromium.
 * - **Focus.** A click focuses the frame, where `j`/`k` cannot be seen. The
 *   app gives focus back to the reader once the pointer is up, unless the user
 *   selected text (so Copy works) or moved focus with the keyboard.
 *
 * DOM reads and writes from the parent work on WebKit; only listeners do not.
 */
import { FRAME_SIGNAL, FRAME_SIGNAL_TARGET } from './frame-document';

const PROBE_EVENT = 'eos-listener-probe';
let listenersRun: boolean | undefined;

/**
 * Whether listeners the app adds to a sandboxed frame's nodes run. The engine
 * does not change, so the first answer is kept; on WebKit the probe logs one
 * "Blocked script execution" line to the console.
 */
export function frameListenersRun(doc: Document): boolean {
  if (listenersRun === undefined) {
    let ran = false;
    const probe = (): void => { ran = true; };
    const EventType = doc.defaultView?.Event ?? Event;
    doc.addEventListener(PROBE_EVENT, probe);
    try {
      doc.dispatchEvent(new EventType(PROBE_EVENT));
    } finally {
      doc.removeEventListener(PROBE_EVENT, probe);
    }
    listenersRun = ran;
  }
  return listenersRun;
}

/**
 * Whether the frame should keep focus: the pointer is pressed (a selection may
 * be starting), text is selected (Copy needs the frame focused) or an element
 * holds focus that the user moved there (Tab through links, then Enter).
 */
export function frameKeepsFocus(doc: Document): boolean {
  const root = doc.documentElement;
  if (matches(root, ':active')) return true;
  const selection = doc.getSelection();
  if (selection && !selection.isCollapsed) return true;
  return heldFocus(doc) !== null;
}

/**
 * The element in the frame that should keep focus, if any. A click on text
 * focuses the body, and a click on a link focuses the link without
 * `:focus-visible`: both give focus back. Anything else keeps it. The keyboard
 * can focus elements that never match `:focus-visible` themselves, such as a
 * `<details>` whose built-in summary has focus (the conv-23 sample's first Tab
 * stop); giving that focus back sent Tab to the reader's header again.
 */
function heldFocus(doc: Document): Element | null {
  const focused = doc.activeElement;
  if (!focused || focused === doc.body || focused === doc.documentElement) return null;
  if (matches(focused, ':focus-visible') || !matches(focused, 'a[data-eos-href]')) return focused;
  return null;
}

function matches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

/** Heights this module set, so a later fit may replace them (and never the mail's own). */
const fittedHeights = new WeakSet<HTMLImageElement>();

/**
 * A broken image keeps the shape its width and height attributes give it.
 * With `height: auto`, WebKit draws a failed image square and ignores
 * `aspect-ratio` on it, so the height is set in pixels from the rendered width.
 * Call it with the frame at zoom 1. Loaded images, images with no source
 * (withheld remote images, cid images not yet fetched) and images whose inline
 * style sets a height are left alone.
 */
export function keepBrokenImageHeight(img: HTMLImageElement): void {
  if (!img.getAttribute('src') || !img.complete || img.naturalWidth !== 0) return;
  if (img.style.height && !fittedHeights.has(img)) return;
  const width = Number(img.getAttribute('width'));
  const height = Number(img.getAttribute('height'));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return;
  img.style.height = '';
  const rendered = img.offsetWidth;
  if (rendered <= 0) return;
  img.style.height = `${(rendered * height) / width}px`;
  fittedHeights.add(img);
}

/**
 * Scrolls the nearest scrolling ancestor of the frame so `target`, an element
 * inside the frame, is visible. Positions are taken as fractions of the frame
 * document's height, so the root's zoom does not matter.
 */
export function revealFrameElement(frame: HTMLIFrameElement, target: Element, margin = 24): void {
  const doc = frame.contentDocument;
  if (!doc) return;
  const frameRect = frame.getBoundingClientRect();
  const rootRect = doc.documentElement.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  if (frameRect.height <= 0 || rootRect.height <= 0) return;
  const scale = frameRect.height / rootRect.height;
  const top = frameRect.top + (rect.top - rootRect.top) * scale;
  const bottom = frameRect.top + (rect.bottom - rootRect.top) * scale;
  const view = frame.ownerDocument.defaultView;
  let scroller: Element | null = frame.parentElement;
  while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /auto|scroll/.test(view?.getComputedStyle(scroller).overflowY ?? ''))) {
    scroller = scroller.parentElement;
  }
  const box = scroller ?? frame.ownerDocument.scrollingElement;
  if (!box) return;
  const visible = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: view?.innerHeight ?? 0 };
  if (top < visible.top + margin) {
    box.scrollTop -= visible.top + margin - top;
  } else if (bottom > visible.bottom - margin) {
    box.scrollTop += Math.min(bottom - (visible.bottom - margin), top - (visible.top + margin));
  }
}

export interface FrameSignalOptions {
  /** A link was activated in the frame. */
  onLink(link: Element): void;
  /** The frame has focus it should not keep; move it back to the app. */
  releaseFocus(): void;
  /** Milliseconds between focus checks while the frame has focus. */
  pollMs?: number;
}

/** Sets up the WebKit path for one loaded frame document; returns its cleanup. */
export function attachFrameSignals(element: HTMLIFrameElement, doc: Document, options: FrameSignalOptions): () => void {
  const win = element.contentWindow;
  const parentWindow = element.ownerDocument.defaultView;
  const root = doc.documentElement;
  if (!win || !parentWindow) return () => {};
  const nonce = `eos-${Math.random().toString(36).slice(2, 10)}`;
  // Relative fragments in a srcdoc document resolve against the app's URL, so
  // every fragment URL here is absolute: the frame's own URL (about:srcdoc).
  const base = win.location.href.split('#')[0];
  const prefix = `#${nonce}-`;
  const links = [...doc.querySelectorAll('a[data-eos-href]')];
  const added: Element[] = [];
  links.forEach((link, index) => {
    link.setAttribute('href', `${base}${prefix}${index}`);
    const target = doc.createElement(FRAME_SIGNAL_TARGET);
    target.id = `${nonce}-${index}`;
    added.push(target);
  });
  const signal = doc.createElement(FRAME_SIGNAL);
  added.push(signal);
  // After the body, so mail selectors such as `body > :last-child` do not match.
  root.append(...added);

  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingLink = 0;
  let revealed: Element | null = null;
  const poll = options.pollMs ?? 100;
  const check = (): void => {
    timer = undefined;
    if (!active || element.ownerDocument.activeElement !== element) {
      revealed = null;
      return;
    }
    if (frameKeepsFocus(doc)) {
      // WebKit does not scroll the reader to an element focused by keyboard
      // inside the full-height frame, so a link below the fold stayed hidden.
      const focused = heldFocus(doc);
      if (focused && focused !== revealed) {
        revealed = focused;
        revealFrameElement(element, focused);
      }
      timer = setTimeout(check, poll);
      return;
    }
    revealed = null;
    options.releaseFocus();
  };
  const watchFocus = (): void => {
    if (active && timer === undefined) timer = setTimeout(check, 0);
  };
  const takeLink = (): void => {
    if (pendingLink) return;
    let hash = '';
    try {
      hash = win.location.hash;
    } catch {
      return;
    }
    if (!hash.startsWith(prefix)) return;
    // The fragment is read here; the reset and the report wait for the next
    // frame. Clearing :target now would resize the signal again during this
    // observer's own delivery ("ResizeObserver loop completed with undelivered
    // notifications"), and so would the dialog the report opens.
    const link = links[Number(hash.slice(prefix.length))];
    pendingLink = requestAnimationFrame(() => {
      pendingLink = 0;
      if (!active) return;
      try {
        // Clears :target (the idle id matches nothing, so nothing scrolls),
        // then restores the plain URL without another navigation.
        win.location.replace(`${base}${prefix}idle`);
        win.history.replaceState(null, '', base);
      } catch {
        // A stale fragment only delays the next activation of the same link.
      }
      if (link) options.onLink(link);
    });
  };

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (!active) return;
    takeLink();
    watchFocus();
  });
  observer?.observe(signal);
  // Focus entering the frame blurs the app's window.
  parentWindow.addEventListener('blur', watchFocus);

  return () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    cancelAnimationFrame(pendingLink);
    observer?.disconnect();
    parentWindow.removeEventListener('blur', watchFocus);
    for (const link of links) link.removeAttribute('href');
    for (const node of added) node.remove();
  };
}

/** For tests: forget the probe result. */
export function resetFrameListenerProbe(): void {
  listenersRun = undefined;
}
