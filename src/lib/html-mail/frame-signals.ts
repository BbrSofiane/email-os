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
 * has keyboard focus (Tab through links, then Enter).
 */
export function frameKeepsFocus(doc: Document): boolean {
  const root = doc.documentElement;
  if (matches(root, ':active')) return true;
  const selection = doc.getSelection();
  if (selection && !selection.isCollapsed) return true;
  const focused = doc.activeElement;
  if (!focused || focused === doc.body || focused === root) return false;
  return matches(focused, ':focus-visible');
}

function matches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

/**
 * A broken image keeps the shape its width and height attributes give it. With
 * `height: auto`, WebKit draws a failed image square (Chromium already uses the
 * attributes' ratio). Loaded images and images with no source (withheld
 * remote images, cid images not yet fetched) are left alone.
 */
export function keepBrokenImageRatio(img: HTMLImageElement): void {
  if (!img.getAttribute('src') || !img.complete || img.naturalWidth !== 0 || img.style.aspectRatio) return;
  const width = Number(img.getAttribute('width'));
  const height = Number(img.getAttribute('height'));
  if (Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) {
    img.style.aspectRatio = `${width} / ${height}`;
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
  const poll = options.pollMs ?? 100;
  const check = (): void => {
    timer = undefined;
    if (!active || element.ownerDocument.activeElement !== element) return;
    if (frameKeepsFocus(doc)) {
      timer = setTimeout(check, poll);
      return;
    }
    options.releaseFocus();
  };
  const watchFocus = (): void => {
    if (active && timer === undefined) timer = setTimeout(check, 0);
  };
  const takeLink = (): void => {
    let hash = '';
    try {
      hash = win.location.hash;
    } catch {
      return;
    }
    if (!hash.startsWith(prefix)) return;
    const link = links[Number(hash.slice(prefix.length))];
    try {
      // Clears :target (the idle id matches nothing, so nothing scrolls), then
      // restores the plain URL without another navigation.
      win.location.replace(`${base}${prefix}idle`);
      win.history.replaceState(null, '', base);
    } catch {
      // A stale fragment only delays the next activation of the same link.
    }
    if (link) options.onLink(link);
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
