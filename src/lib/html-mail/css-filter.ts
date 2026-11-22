/**
 * CSS filter for HTML mail (ADR 0006 decision 8).
 *
 * Works on tokens from `css-tokenizer.ts`, which splits text as a browser does
 * and refuses the rest. Malformed input drops the whole stylesheet or style
 * attribute; nothing is repaired. Output is serialised only from kept tokens,
 * and tokenizing it again gives those tokens, so what was checked here is what
 * the browser sees.
 *
 * Rules:
 * - a backslash or `<` anywhere drops the input: CSS escapes are how filters
 *   get bypassed, and filtered text in a `<style>` element can never close it;
 * - only `@media` and `@supports` at-rules are kept (filtered recursively);
 * - functions in values must be on the allowlist; `position` must be a value
 *   that stays in the document flow's box; declarations that mention
 *   `expression`, `javascript:`, `vbscript:`, `-moz-binding` or `behavior`
 *   are dropped, and so are nested rules and custom properties;
 * - `url()` is allowed for `data:image/(png|jpeg|gif|webp);base64` and `cid:`;
 *   `https:` only when remote images are loaded (otherwise the declaration is
 *   dropped and counted); every other URL drops the declaration.
 */
import { tokenizeCss, type CssToken } from './css-tokenizer';

export interface CssFilterOptions {
  remoteImages: boolean;
}

export interface CssFilterResult {
  css: string;
  /** Declarations dropped only because they would load a remote resource. */
  blockedRemote: number;
}

/** Nested `@media` / `@supports` blocks kept. */
const MAX_NESTING = 8;
const PROPERTY_NAME = /^-?[a-z][a-z0-9-]*$/;
const FORBIDDEN_PROPERTIES = new Set(['behavior', '-moz-binding']);
const FORBIDDEN_VALUE = /expression|javascript\s*:|vbscript\s*:|-moz-binding|behavior/i;
const DATA_IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;
const CID_URL = /^cid:[^\s"'()]+$/i;
const KEPT_AT_RULE = /^@(media|supports)$/i;
const RESOURCE_FUNCTION = /^(url|src|image)\($/i;

const POSITIONS = new Set([
  'static', 'relative', 'absolute', 'inherit', 'initial', 'unset', 'revert', 'important',
]);

const VALUE_FUNCTIONS = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color',
  'calc', 'min', 'max', 'clamp',
  'linear-gradient', 'radial-gradient', 'conic-gradient',
  'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
  '-webkit-linear-gradient', '-webkit-radial-gradient',
  '-webkit-repeating-linear-gradient', '-webkit-repeating-radial-gradient',
  'translate', 'translatex', 'translatey', 'scale', 'scalex', 'scaley', 'rotate',
  'skew', 'skewx', 'skewy', 'matrix', 'cubic-bezier', 'steps',
  'rect', 'inset', 'circle', 'ellipse', 'polygon', 'counter', 'counters', 'url',
]);

/** Filters the text of one `<style>` element. */
export function filterCss(css: string, options: CssFilterOptions): CssFilterResult {
  const tokens = tokenizeCss(withoutCommentWrapper(css));
  if (tokens === null) return { css: '', blockedRemote: 0 };
  return filterRules(tokens, 0, tokens.length, options, 0);
}

/** Filters one `style="…"` attribute value. */
export function filterStyleAttribute(style: string, options: CssFilterOptions): CssFilterResult {
  const tokens = tokenizeCss(style);
  if (tokens === null) return { css: '', blockedRemote: 0 };
  return filterDeclarations(tokens, 0, tokens.length, options);
}

/** Desktop mail clients wrap a whole sheet in an HTML comment, which CSS ignores. */
function withoutCommentWrapper(css: string): string {
  const text = css.trim();
  return text.startsWith('<!--') && text.endsWith('-->') && text.length >= 7
    ? text.slice(4, -3)
    : css;
}

/** Rules between two token indexes: `selector { … }` and kept at-rules. */
function filterRules(
  tokens: CssToken[],
  start: number,
  end: number,
  options: CssFilterOptions,
  depth: number,
): CssFilterResult {
  const kept: string[] = [];
  let blockedRemote = 0;
  let preludeStart = start;
  for (let i = start; i < end; i += 1) {
    const token = tokens[i]!;
    if (token.kind === ';') {
      // Ends a statement at-rule, which is thereby dropped.
      preludeStart = i + 1;
    } else if (token.kind === '{') {
      const prelude = trimmed(tokens, preludeStart, i);
      const inner = filterBlock(tokens, prelude, i, options, depth);
      blockedRemote += inner.blockedRemote;
      if (inner.css) kept.push(inner.css);
      i = token.close;
      preludeStart = i + 1;
    } else if (token.close >= 0) {
      i = token.close;
    }
  }
  return { css: kept.join('\n'), blockedRemote };
}

/** One rule whose `{` is at `open`. */
function filterBlock(
  tokens: CssToken[],
  prelude: CssToken[],
  open: number,
  options: CssFilterOptions,
  depth: number,
): CssFilterResult {
  const dropped = { css: '', blockedRemote: 0 };
  if (prelude.length === 0) return dropped;
  const isAtRule = prelude[0]!.kind === 'at-keyword';
  const refused = prelude.some((token, index) => (
    token.kind === 'url'
    || (token.kind === 'function' && RESOURCE_FUNCTION.test(token.text))
    || (token.kind === 'at-keyword' && index > 0)
    || (token.kind === 'delim' && token.text === '@')
  ));
  if (refused) return dropped;

  const close = tokens[open]!.close;
  if (!isAtRule) {
    const inner = filterDeclarations(tokens, open + 1, close, options);
    return { ...inner, css: inner.css && `${serialize(prelude)} { ${inner.css} }` };
  }
  if (!KEPT_AT_RULE.test(prelude[0]!.text) || depth >= MAX_NESTING) return dropped;
  const inner = filterRules(tokens, open + 1, close, options, depth + 1);
  return { ...inner, css: inner.css && `${serialize(prelude)} {\n${inner.css}\n}` };
}

/** `prop: value; …` between two token indexes → the kept declarations. */
function filterDeclarations(
  tokens: CssToken[],
  start: number,
  end: number,
  options: CssFilterOptions,
): CssFilterResult {
  const kept: string[] = [];
  let blockedRemote = 0;
  let declarationStart = start;
  const finish = (stop: number): void => {
    const result = filterDeclaration(tokens, declarationStart, stop, options);
    if (result === 'remote') blockedRemote += 1;
    else if (result !== null) kept.push(result);
  };
  for (let i = start; i < end; i += 1) {
    const token = tokens[i]!;
    if (token.kind === ';') {
      finish(i);
      declarationStart = i + 1;
    } else if (token.kind === '{') {
      // A nested rule: its prelude and block are dropped together.
      i = token.close;
      declarationStart = i + 1;
    } else if (token.close >= 0) {
      i = token.close;
    }
  }
  finish(end);
  return { css: kept.join('; '), blockedRemote };
}

/** One declaration as text, `'remote'` when only its URL is withheld, or null. */
function filterDeclaration(
  tokens: CssToken[],
  start: number,
  end: number,
  options: CssFilterOptions,
): string | 'remote' | null {
  let colon = skipWhitespace(tokens, start, end);
  if (colon >= end || tokens[colon]!.kind !== 'ident') return null;
  const property = tokens[colon]!.text.toLowerCase();
  colon = skipWhitespace(tokens, colon + 1, end);
  if (colon >= end || tokens[colon]!.kind !== ':') return null;
  if (!PROPERTY_NAME.test(property) || FORBIDDEN_PROPERTIES.has(property)) return null;

  let remote = false;
  for (let i = colon + 1; i < end; i += 1) {
    const token = tokens[i]!;
    if (property === 'position' && token.kind === 'ident' && !POSITIONS.has(token.text.toLowerCase())) {
      return null;
    }
    if (token.kind === 'function' && !VALUE_FUNCTIONS.has(token.text.slice(0, -1).toLowerCase())) {
      return null;
    }
    // An unquoted address outside url() has no meaning in a value.
    if (token.text === '/' && i + 1 < end && tokens[i + 1]!.text === '/') return null;
    const url = urlOf(tokens, i);
    if (url === undefined) continue;
    const verdict = url === null ? 'forbidden' : checkUrl(url, options);
    if (verdict === 'forbidden') return null;
    if (verdict === 'remote') remote = true;
  }
  const value = serialize(trimmed(tokens, colon + 1, end));
  if (!value || FORBIDDEN_VALUE.test(value)) return null;
  return remote ? 'remote' : `${property}: ${value}`;
}

/** The URL of a url token or `url("…")`; null when malformed; undefined otherwise. */
function urlOf(tokens: CssToken[], index: number): string | null | undefined {
  const token = tokens[index]!;
  if (token.kind === 'url') return token.text.slice(4, -1).trim();
  if (token.kind !== 'function' || token.text.toLowerCase() !== 'url(') return undefined;
  const argument = skipWhitespace(tokens, index + 1, token.close);
  const rest = skipWhitespace(tokens, argument + 1, token.close);
  if (tokens[argument]!.kind !== 'string' || rest !== token.close) return null;
  return tokens[argument]!.text.slice(1, -1);
}

function checkUrl(url: string, options: CssFilterOptions): 'ok' | 'remote' | 'forbidden' {
  if (DATA_IMAGE_URL.test(url) || CID_URL.test(url)) return 'ok';
  if (!/^https:\/\//i.test(url)) return 'forbidden';
  try {
    if (new URL(url).protocol !== 'https:') return 'forbidden';
  } catch {
    return 'forbidden';
  }
  return options.remoteImages ? 'ok' : 'remote';
}

function skipWhitespace(tokens: CssToken[], from: number, end: number): number {
  let i = from;
  while (i < end && tokens[i]!.kind === 'whitespace') i += 1;
  return i;
}

function trimmed(tokens: CssToken[], start: number, end: number): CssToken[] {
  const from = skipWhitespace(tokens, start, end);
  let to = end;
  while (to > from && tokens[to - 1]!.kind === 'whitespace') to -= 1;
  return tokens.slice(from, to);
}

/** Kept tokens as text; whitespace and comments become one space. */
function serialize(tokens: CssToken[]): string {
  const parts: string[] = [];
  let spaced = true;
  for (const token of tokens) {
    const space = token.kind === 'whitespace' || token.afterComment;
    if (space && !spaced) parts.push(' ');
    spaced = spaced || space;
    if (token.kind === 'whitespace') continue;
    parts.push(token.text);
    spaced = false;
  }
  return parts.join('').trimEnd();
}
