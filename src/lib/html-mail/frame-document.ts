import type { SanitizedMail } from './sanitize';

/** No scripts, forms, popups, top-navigation, modals or downloads (ADR 0006 decision 9). */
export const FRAME_SANDBOX = 'allow-same-origin';

/** Policy applied before any mail content is parsed. */
export function frameCsp(remoteImages: boolean): string {
  return `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:${remoteImages ? ' https:' : ''}; font-src data:; form-action 'none'`;
}

/**
 * Elements the app adds after the frame's body when the engine will not run the
 * app's listeners on frame nodes (WebKit; see `frame-signals.ts`). Mail cannot
 * contain them: the sanitiser drops custom elements.
 */
export const FRAME_SIGNAL_TARGET = 'eos-target';
export const FRAME_SIGNAL = 'eos-signal';

/**
 * State the user agent changes without script, turned into a size the parent's
 * ResizeObserver sees: width while a link's fragment target is the document's
 * target, height while the pointer is pressed in the frame.
 *
 * Mail CSS must not be able to fix the signal's size or show a target. Important
 * declarations in a cascade layer beat every unlayered important declaration,
 * whatever its specificity, and the CSS filter keeps no `@layer` (only `@media`
 * and `@supports`), so mail cannot reach these declarations. `all: initial`
 * resets anything else mail might set (min-width, padding, ...).
 */
export const FRAME_SIGNAL_CSS = `@layer eos-signal {
${FRAME_SIGNAL_TARGET} { all: initial !important; display: none !important; }
${FRAME_SIGNAL} { all: initial !important; display: block !important; position: fixed !important; top: 0 !important; left: 0 !important; width: 0 !important; height: 0 !important; overflow: hidden !important; visibility: hidden !important; pointer-events: none !important; }
${FRAME_SIGNAL_TARGET}:target ~ ${FRAME_SIGNAL} { width: 1px !important; }
html:active > ${FRAME_SIGNAL} { height: 1px !important; }
}`;

export interface FrameTheme {
  mode: 'paper' | 'adaptive';
  fontFamily: string;
  fontSize: string;
  lineHeight: string;
  textColour: string;
  linkColour: string;
}

/** Builds the isolated document using only validated values in our base CSS. */
export function buildFrameDocument(mail: SanitizedMail, options: { remoteImages: boolean; theme: FrameTheme; quoteOpen: boolean }): string {
  const { theme } = options;
  const safe = (value: string, pattern: RegExp, fallback: string) => pattern.test(value) ? value : fallback;
  const family = safe(theme.fontFamily, /^[a-zA-Z0-9 ,'"-]+$/, 'sans-serif');
  const size = safe(theme.fontSize, /^\d+(?:\.\d+)?(?:px|rem|em)$/, '16px');
  const leading = safe(theme.lineHeight, /^\d+(?:\.\d+)?(?:px|rem|em)?$/, '24px');
  const colour = /^#(?:[a-fA-F0-9]{3,4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$|^rgba?\([\d\s,.]+\)$/;
  const text = safe(theme.textColour, colour, '#ffffff');
  const link = safe(theme.linkColour, colour, '#bba5ed');
  const paper = theme.mode === 'paper';
  const base = `html { color-scheme: ${paper ? 'light' : 'dark'}; background: ${paper ? '#ffffff' : 'transparent'}; color: ${paper ? '#1f1f1f' : text}; ${paper ? 'padding: 16px;' : `font-family: ${family}; font-size: ${size}; line-height: ${leading};`} }
body { margin: 0; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; }
img[data-eos-src] { outline: 1px dashed rgba(128, 128, 128, 0.45); outline-offset: -1px; }
table { max-width: none; }
[data-eos-href] { cursor: pointer; -webkit-user-drag: none; }
/* WebKit path: links carry a fragment href (frame-signals.ts). Undo the UA link style so they look as on Chromium; zero specificity, so mail rules still win. */
:where(a[data-eos-href][href]) { color: inherit; text-decoration: none; }
${paper ? '' : `[data-eos-href] { color: ${link}; text-decoration: underline; }`}
html:not(.eos-quote-open) [data-eos-quote="trailing"] { display: none !important; }
${FRAME_SIGNAL_CSS}`;
  return `<!doctype html><html class="${options.quoteOpen ? 'eos-quote-open' : ''}"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${frameCsp(options.remoteImages)}"><style>${base}</style><style>${mail.styles}</style></head><body>${mail.body}</body></html>`;
}

/** Scales wide content to fit, retaining a minimum readable zoom. */
export function fitZoom(contentWidth: number, available: number): number {
  return contentWidth <= available ? 1 : Math.max(0.5, available / contentWidth);
}
