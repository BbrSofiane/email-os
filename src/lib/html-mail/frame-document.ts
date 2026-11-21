import type { SanitizedMail } from './sanitize';

/** No scripts, forms, popups, top-navigation, modals or downloads (ADR 0006 decision 9). */
export const FRAME_SANDBOX = 'allow-same-origin';

/** Policy applied before any mail content is parsed. */
export function frameCsp(remoteImages: boolean): string {
  return `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:${remoteImages ? ' https:' : ''}; font-src data:; form-action 'none'`;
}

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
[data-eos-href] { cursor: pointer; }
${paper ? '' : `[data-eos-href] { color: ${link}; text-decoration: underline; }`}
html:not(.eos-quote-open) [data-eos-quote="trailing"] { display: none !important; }`;
  return `<!doctype html><html class="${options.quoteOpen ? 'eos-quote-open' : ''}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameCsp(options.remoteImages)}"><style>${base}</style><style>${mail.styles}</style></head><body>${mail.body}</body></html>`;
}

/** Scales wide content to fit, retaining a minimum readable zoom. */
export function fitZoom(contentWidth: number, available: number): number {
  return contentWidth <= available ? 1 : Math.max(0.5, available / contentWidth);
}
