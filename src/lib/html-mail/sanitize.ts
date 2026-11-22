/**
 * HTML mail sanitiser (ADR 0006 decision 8).
 *
 * Mail HTML is parsed by DOMPurify into an inert document (DOMParser: no
 * browsing context, so nothing loads and no handler can run), cleaned there,
 * post-processed there, and serialised from there. The result is only ever
 * parsed again inside the sandboxed message frame. It is never parsed into the
 * app document (no innerHTML on app nodes), so a parser differential cannot
 * reach the app's realm or its IPC.
 *
 * After sanitising:
 * - no element has `href`; links keep their element and carry the target in
 *   `data-eos-href` (http, https and mailto only);
 * - `cid:` images carry `data-eos-cid`; remote https images carry
 *   `data-eos-src` / `data-eos-background` until the user loads images;
 * - style attributes and `<style>` text are filtered by `css-filter.ts`;
 * - a trailing quote is marked `data-eos-quote="trailing"`.
 */
import createDOMPurify from 'dompurify';
import { filterCss, filterStyleAttribute } from './css-filter';

export interface SanitizedMail {
  /** Filtered text of every `<style>` element, for the frame's head. */
  styles: string;
  /** `<div class="eos-mail-body" …>…</div>`: the cleaned body content. */
  body: string;
  /** Remote resources withheld because remote images are not loaded. */
  remoteBlocked: number;
  /** Content-IDs referenced by `cid:` images, unique, in document order. */
  cidReferences: string[];
  /** Whether the mail sets its own text or background colours (paper card). */
  hasOwnColours: boolean;
  /** Whether a trailing quote was found and marked. */
  hasTrailingQuote: boolean;
}

export interface SanitizeOptions {
  /** True once the user chose "Load images" for this message. */
  remoteImages: boolean;
}

/** Elements removed outright (ADR 0006 decision 8). */
const FORBIDDEN_TAGS = [
  'script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'link', 'meta', 'base',
  'audio', 'video', 'source', 'track', 'portal', 'template', 'svg', 'math', 'title',
];

/** Of those, the ones whose content is dropped too (not just unwrapped). */
const FORBIDDEN_CONTENTS = [
  'script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'select', 'textarea', 'option', 'audio', 'video', 'portal', 'template',
  'svg', 'math', 'title',
];

/** URL-bearing or behaviour attributes that never survive. */
const FORBIDDEN_ATTRIBUTES = new Set([
  'srcset', 'ping', 'formaction', 'xlink:href', 'action', 'target', 'poster', 'cite',
  'longdesc', 'lowsrc', 'dynsrc',
]);

/** Elements that may keep a (filtered) `background` image attribute. */
const BACKGROUND_TAGS = new Set(['TABLE', 'TD', 'TH', 'TR', 'BODY']);

/** Body attributes carried over to the wrapper so the mail keeps its canvas. */
const BODY_ATTRIBUTES = ['bgcolor', 'text', 'link', 'style', 'background', 'data-eos-background'];

/** Quote containers of common mail clients (ADR 0006 decision 17). */
const QUOTE_SELECTOR = [
  '.gmail_quote', 'blockquote[type="cite"]', '#divRplyFwdMsg', '#appendonsend',
  '.yahoo_quoted', '.protonmail_quote',
].join(', ');

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;
const COLOUR_DECLARATION = /(?:^|[;{])\s*(?:color|background|background-color)\s*:/i;

export function sanitizeMailHtml(html: string, options: SanitizeOptions): SanitizedMail {
  const result: SanitizedMail = {
    styles: '',
    body: '',
    remoteBlocked: 0,
    cidReferences: [],
    hasOwnColours: false,
    hasTrailingQuote: false,
  };
  // A fresh instance per call: no hooks or configuration leak between calls.
  const purifier = createDOMPurify(window);
  const root = purifier.sanitize(html, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    USE_PROFILES: { html: true },
    ALLOW_DATA_ATTR: false,
    SANITIZE_DOM: true,
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_CONTENTS: FORBIDDEN_CONTENTS,
    ADD_TAGS: ['style'],
  }) as unknown as HTMLElement | null;
  const body = root?.querySelector('body');
  if (!root || !body) return result;

  collectStyles(root, options, result);
  markTrailingQuote(body, result);
  const contentIds = new Set<string>();
  for (const element of [body, ...body.querySelectorAll('*')]) {
    cleanElement(element, options, result, contentIds);
  }
  result.cidReferences = [...contentIds];

  // Built in the inert document by moving nodes: never re-parsed here.
  const inert = body.ownerDocument;
  const wrapper = inert.createElement('div');
  wrapper.className = 'eos-mail-body';
  for (const name of BODY_ATTRIBUTES) {
    const value = body.getAttribute(name);
    if (value !== null) wrapper.setAttribute(name, value);
  }
  while (body.firstChild) wrapper.appendChild(body.firstChild);
  result.body = wrapper.outerHTML;
  return result;
}

/** Filters every `<style>` element into `styles` and removes it from the tree. */
function collectStyles(root: Element, options: SanitizeOptions, result: SanitizedMail): void {
  const styles: string[] = [];
  for (const style of root.querySelectorAll('style')) {
    const filtered = filterCss(style.textContent ?? '', options);
    result.remoteBlocked += filtered.blockedRemote;
    if (filtered.css) {
      styles.push(filtered.css);
      if (COLOUR_DECLARATION.test(filtered.css)) result.hasOwnColours = true;
    }
    style.remove();
  }
  result.styles = styles.join('\n');
}

/**
 * Marks the first quote container that ends the message: nothing with text or
 * an image follows it in document order outside it. For Outlook's separators
 * the quote is the separator and every sibling after it. Linear in the tree:
 * what follows each node is computed once, from the end.
 */
function markTrailingQuote(body: HTMLElement, result: SanitizedMail): void {
  const candidates = body.querySelectorAll(QUOTE_SELECTOR);
  if (candidates.length === 0) return;
  const followed = nodesFollowedByContent(body);
  for (const candidate of candidates) {
    const separator = candidate.id === 'divRplyFwdMsg' || candidate.id === 'appendonsend';
    // A separator's own following siblings are part of the quote.
    const outer = separator ? candidate.parentNode : candidate;
    if (outer && followed.has(outer)) continue;
    candidate.setAttribute('data-eos-quote', 'trailing');
    if (separator) {
      for (let next = candidate.nextElementSibling; next; next = next.nextElementSibling) {
        next.setAttribute('data-eos-quote', 'trailing');
      }
    }
    result.hasTrailingQuote = true;
    return;
  }
}

/** The nodes of `body` after which, outside them, text or an image follows. */
function nodesFollowedByContent(body: HTMLElement): Set<Node> {
  const nodes: Node[] = [];
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_ALL);
  while (walker.nextNode()) nodes.push(walker.currentNode);

  // From the end, so siblings after a node and its children are known first.
  const beforeContent = new Set<Node>();
  const withContent = new Set<Node>();
  const holdsOrPrecedes = (node: Node | null): boolean =>
    node !== null && (withContent.has(node) || beforeContent.has(node));
  for (const node of nodes.reverse()) {
    if (holdsOrPrecedes(node.nextSibling)) beforeContent.add(node);
    const isContent = node.nodeType === Node.TEXT_NODE
      ? (node.nodeValue ?? '').trim() !== ''
      : node instanceof Element && node.matches('img');
    if (isContent || holdsOrPrecedes(node.firstChild)) withContent.add(node);
  }

  // Parents before children: content after an ancestor also follows the node.
  const followed = new Set<Node>();
  for (const node of nodes.reverse()) {
    const parent = node.parentNode;
    if (beforeContent.has(node) || (parent && followed.has(parent))) followed.add(node);
  }
  return followed;
}

/** Applies the attribute, link, image and style rules to one element. */
function cleanElement(
  element: Element,
  options: SanitizeOptions,
  result: SanitizedMail,
  contentIds: Set<string>,
): void {
  for (const attribute of [...element.attributes]) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith('on') || FORBIDDEN_ATTRIBUTES.has(name)) {
      element.removeAttribute(attribute.name);
    }
  }
  cleanLink(element);

  if (element.tagName === 'IMG') {
    cleanImageAttribute(element, 'src', options, result, contentIds);
  } else {
    element.removeAttribute('src');
  }
  if (BACKGROUND_TAGS.has(element.tagName)) {
    cleanImageAttribute(element, 'background', options, result, contentIds);
  } else {
    element.removeAttribute('background');
  }

  const style = element.getAttribute('style');
  if (style !== null) {
    const filtered = filterStyleAttribute(style, options);
    result.remoteBlocked += filtered.blockedRemote;
    if (filtered.css) {
      element.setAttribute('style', filtered.css);
      if (COLOUR_DECLARATION.test(filtered.css)) result.hasOwnColours = true;
    } else {
      element.removeAttribute('style');
    }
  }

  if (declaresColours(element)) result.hasOwnColours = true;
}

/** Moves an `<a href>` target to `data-eos-href`; no `href` survives anywhere. */
function cleanLink(element: Element): void {
  const href = element.getAttribute('href');
  if (href === null) return;
  element.removeAttribute('href');
  if (element.tagName !== 'A') return;
  let url: URL;
  try {
    url = new URL(href.trim());
  } catch {
    return; // Relative and malformed links are dropped.
  }
  if (!LINK_PROTOCOLS.has(url.protocol)) return;
  element.setAttribute('data-eos-href', url.href);
  element.setAttribute('role', 'link');
  element.setAttribute('tabindex', '0');
}

/** `cid:` → data-eos-cid; data images stay; https → src or withheld; else dropped. */
function cleanImageAttribute(
  element: Element,
  attribute: 'src' | 'background',
  options: SanitizeOptions,
  result: SanitizedMail,
  contentIds: Set<string>,
): void {
  const value = element.getAttribute(attribute)?.trim();
  element.removeAttribute(attribute);
  if (!value) return;

  if (/^cid:/i.test(value)) {
    let cid: string;
    try {
      cid = decodeURIComponent(value.slice(4));
    } catch {
      return; // Invalid percent-encoding is dropped.
    }
    if (!cid) return;
    element.setAttribute('data-eos-cid', cid);
    contentIds.add(cid);
    return;
  }
  if (DATA_IMAGE.test(value)) {
    element.setAttribute(attribute, value);
    return;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return; // Relative and malformed URLs are dropped.
  }
  if (url.protocol !== 'https:') return;
  if (options.remoteImages) {
    element.setAttribute(attribute, url.href);
  } else {
    element.setAttribute(attribute === 'background' ? 'data-eos-background' : 'data-eos-src', url.href);
    result.remoteBlocked += 1;
  }
}

/** Presentational colour attributes (ADR 0006 decision 15). */
function declaresColours(element: Element): boolean {
  if (element.hasAttribute('bgcolor') || element.hasAttribute('background')) return true;
  if (element.hasAttribute('data-eos-background')) return true;
  if (element.tagName === 'FONT' && element.hasAttribute('color')) return true;
  if (element.tagName === 'BODY' && (element.hasAttribute('text') || element.hasAttribute('link'))) {
    return true;
  }
  return false;
}
