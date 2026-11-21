/**
 * CSS filter for HTML mail (ADR 0006 decision 8).
 *
 * A small string-aware tokenizer, not regexes over the whole text: it respects
 * quoted strings, parentheses and nested blocks, removes comments first, and
 * re-serialises only the selectors and declarations it kept, so malformed input
 * cannot leak through. Anything it cannot parse is dropped, never repaired.
 *
 * Rules:
 * - a backslash anywhere drops the declaration (or the whole stylesheet):
 *   CSS escapes are how filters get bypassed and mail rarely needs them;
 * - `<` anywhere drops the declaration or rule, so filtered text placed in a
 *   `<style>` element can never close it;
 * - only `@media` and `@supports` at-rules are kept (filtered recursively);
 * - declarations with `expression(`, `javascript:`, `vbscript:`, `-moz-binding`,
 *   `behavior`, `image-set(` or `@import`, and `position: fixed|sticky`, are
 *   dropped;
 * - `url()` is allowed for `data:image/(png|jpeg|gif|webp);base64` and `cid:`;
 *   `https:` only when remote images are loaded (otherwise the declaration is
 *   dropped and counted); every other URL drops the declaration.
 */

export interface CssFilterOptions {
  remoteImages: boolean;
}

export interface CssFilterResult {
  css: string;
  /** Declarations dropped only because they would load a remote resource. */
  blockedRemote: number;
}

const FORBIDDEN_VALUE = /expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior|image-set\s*\(|@import/i;
const PROPERTY_NAME = /^-?[a-z][a-z0-9-]*$/;
const DATA_IMAGE_URL = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;
const CID_URL = /^cid:[^\s"'()]+$/i;
const KEPT_AT_RULE = /^@(media|supports)\b/i;

/** Filters the text of one `<style>` element. */
export function filterCss(css: string, options: CssFilterOptions): CssFilterResult {
  const input = stripComments(css);
  if (input === null || input.includes('\\')) return { css: '', blockedRemote: 0 };
  return filterRules(input, options);
}

/** Filters one `style="…"` attribute value. */
export function filterStyleAttribute(style: string, options: CssFilterOptions): CssFilterResult {
  const input = stripComments(style);
  if (input === null) return { css: '', blockedRemote: 0 };
  return filterDeclarations(input, options);
}

/** Top-level rules: `selector { … }` and at-rules; anything malformed ends the sheet. */
function filterRules(input: string, options: CssFilterOptions): CssFilterResult {
  const kept: string[] = [];
  let blockedRemote = 0;
  let position = 0;
  while (position < input.length) {
    const open = findBlockStart(input, position);
    if (open === 'malformed') return { css: kept.join('\n'), blockedRemote };
    if (open.index < 0) break;
    const close = findBlockEnd(input, open.index);
    if (close < 0) return { css: kept.join('\n'), blockedRemote };

    const selector = input.slice(open.start, open.index).trim();
    const block = input.slice(open.index + 1, close);
    position = close + 1;
    if (!selector || selector.includes('<')) continue;

    if (selector.startsWith('@')) {
      if (!KEPT_AT_RULE.test(selector)) continue;
      const inner = filterRules(block, options);
      blockedRemote += inner.blockedRemote;
      if (inner.css) kept.push(`${selector} {\n${inner.css}\n}`);
    } else {
      const declarations = filterDeclarations(block, options);
      blockedRemote += declarations.blockedRemote;
      if (declarations.css) kept.push(`${selector} { ${declarations.css} }`);
    }
  }
  return { css: kept.join('\n'), blockedRemote };
}

/**
 * Finds the `{` that opens the next block after `from`, skipping strings,
 * parenthesised text and statement at-rules ending in `;` (such as
 * `@import …;`, which are thereby dropped). `start` is where its prelude begins.
 */
function findBlockStart(
  input: string,
  from: number,
): { start: number; index: number } | 'malformed' {
  let start = from;
  let quote = '';
  let parens = 0;
  for (let i = from; i < input.length; i += 1) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(') parens += 1;
    else if (c === ')') parens -= 1;
    else if (parens === 0 && c === ';') start = i + 1;
    else if (parens === 0 && c === '{') return { start, index: i };
    else if (parens === 0 && c === '}') return 'malformed';
  }
  return { start, index: -1 };
}

/** Index of the `}` matching the `{` at `open`, or -1 when unbalanced. */
function findBlockEnd(input: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < input.length; i += 1) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `prop: value; …` → the kept declarations, re-serialised. */
function filterDeclarations(input: string, options: CssFilterOptions): CssFilterResult {
  const declarations = splitTopLevel(input, ';');
  if (declarations === null) return { css: '', blockedRemote: 0 };
  const kept: string[] = [];
  let blockedRemote = 0;
  for (const declaration of declarations) {
    if (declaration.includes('\\') || declaration.includes('<')) continue;
    const colon = declaration.indexOf(':');
    if (colon < 1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (!PROPERTY_NAME.test(property) || !value) continue;
    if (property === 'behavior' || property === '-moz-binding') continue;
    if (FORBIDDEN_VALUE.test(value)) continue;
    if (property === 'position' && /\b(fixed|sticky)\b/i.test(value)) continue;

    const urls = checkUrls(value, options);
    if (urls === 'remote') {
      blockedRemote += 1;
      continue;
    }
    if (urls === 'forbidden') continue;
    kept.push(`${property}: ${value}`);
  }
  return { css: kept.join('; '), blockedRemote };
}

/** Classifies every `url(…)` in a declaration value. */
function checkUrls(value: string, options: CssFilterOptions): 'ok' | 'remote' | 'forbidden' {
  let quote = '';
  let verdict: 'ok' | 'remote' = 'ok';
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    const match = /^url\s*\(/i.exec(value.slice(i));
    if (!match) continue;
    const start = i + match[0].length;
    const end = findUrlEnd(value, start);
    if (end < 0) return 'forbidden';
    let url = value.slice(start, end).trim();
    const quoted = (url.startsWith('"') && url.endsWith('"')) || (url.startsWith("'") && url.endsWith("'"));
    if (quoted) url = url.slice(1, -1);
    if (/^https:\/\//i.test(url)) {
      if (!options.remoteImages) verdict = 'remote';
    } else if (!CID_URL.test(url) && !DATA_IMAGE_URL.test(url)) {
      return 'forbidden';
    }
    i = end;
  }
  return verdict;
}

/** Index of the `)` closing a `url(` whose argument starts at `start`. */
function findUrlEnd(value: string, start: number): number {
  let quote = '';
  for (let i = start; i < value.length; i += 1) {
    const c = value[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ')') {
      return i;
    }
  }
  return -1;
}

/** Splits at `delimiter` outside strings, parentheses and blocks; null when unbalanced. */
function splitTopLevel(input: string, delimiter: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth += 1;
    } else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (c === delimiter && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  if (quote || depth) return null;
  parts.push(input.slice(start));
  return parts;
}

/** Removes `/* … *\/` comments outside strings; null when one is unterminated. */
function stripComments(input: string): string | null {
  let output = '';
  let quote = '';
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (quote) {
      output += c;
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      output += c;
      continue;
    }
    if (c === '/' && input[i + 1] === '*') {
      const end = input.indexOf('*/', i + 2);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    output += c;
  }
  return quote ? null : output;
}
