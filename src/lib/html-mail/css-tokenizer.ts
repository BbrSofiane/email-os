/**
 * CSS tokenizer for the mail CSS filter (ADR 0006 decision 8).
 *
 * Follows CSS Syntax Level 3 section 4 for the input it accepts, and refuses
 * the input where tokenizers are easily fooled: it returns null for a string
 * that meets a newline, a bad url, an unterminated comment, unbalanced
 * brackets, any backslash, any `<`, `-->` and control characters. One forward
 * pass over the input.
 */

export type CssTokenKind =
  | 'whitespace' | 'ident' | 'function' | 'at-keyword' | 'hash' | 'string' | 'url'
  | 'number' | 'delim' | ':' | ';' | ',' | '(' | ')' | '[' | ']' | '{' | '}';

export interface CssToken {
  kind: CssTokenKind;
  /** Source text; a function token includes its `(`. */
  text: string;
  /** A comment stood before this token, so the two must not be joined. */
  afterComment: boolean;
  /** Index of the closing token, for functions and opening brackets; else -1. */
  close: number;
}

const CLOSER: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
/** C0 controls other than tab and newline, DEL, backslash and `<`. */
// eslint-disable-next-line no-control-regex
const REFUSED = /[\u0000-\u0008\u000b-\u001f\u007f\\<]/;
const NUMBER = /[+-]?(?:\d*\.)?\d+(?:[eE][+-]?\d+)?/y;
const NAME = /[-\w\u0080-￿]*/y;
const WHITESPACE = /[ \t\n]*/y;
/** An unquoted url body; a quote or `(` ends it, which makes the url bad. */
const URL_BODY = /[^"'() \t\n]*/y;

export function tokenizeCss(source: string): CssToken[] | null {
  const input = source.replace(/\r\n?|\f/g, '\n');
  if (REFUSED.test(input)) return null;

  const tokens: CssToken[] = [];
  const open: number[] = [];
  let position = 0;
  let afterComment = false;

  /** End of the sticky `pattern` match at `from`. */
  const skip = (pattern: RegExp, from: number): number => {
    pattern.lastIndex = from;
    const match = pattern.exec(input);
    return match ? from + match[0].length : from;
  };
  const push = (kind: CssTokenKind, end: number): void => {
    tokens.push({ kind, text: input.slice(position, end), afterComment, close: -1 });
    afterComment = false;
    position = end;
  };

  while (position < input.length) {
    const c = input[position]!;
    const next = input[position + 1] ?? '';

    if (c === '/' && next === '*') {
      const end = input.indexOf('*/', position + 2);
      if (end < 0) return null;
      position = end + 2;
      afterComment = true;
    } else if (isWhitespace(c)) {
      push('whitespace', skip(WHITESPACE, position));
    } else if (c === '"' || c === "'") {
      const end = stringEnd(input, position);
      if (end < 0) return null;
      push('string', end);
    } else if (input.startsWith('-->', position)) {
      return null;
    } else if (startsNumber(input, position)) {
      const end = skip(NUMBER, position);
      push('number', input[end] === '%' ? end + 1 : skip(NAME, end));
    } else if (c === '#' && isNameCharacter(next)) {
      push('hash', skip(NAME, position + 1));
    } else if (c === '@' && startsName(input, position + 1)) {
      push('at-keyword', skip(NAME, position + 1));
    } else if (startsName(input, position)) {
      const end = skip(NAME, position);
      if (input[end] !== '(') {
        push('ident', end);
      } else {
        const argument = skip(WHITESPACE, end + 1);
        const isUrl = input.slice(position, end).toLowerCase() === 'url';
        if (isUrl && input[argument] !== '"' && input[argument] !== "'") {
          const close = skip(WHITESPACE, skip(URL_BODY, argument));
          if (input[close] !== ')') return null;
          push('url', close + 1);
        } else {
          open.push(tokens.length);
          push('function', end + 1);
        }
      }
    } else if (c === '(' || c === '[' || c === '{') {
      open.push(tokens.length);
      push(c, position + 1);
    } else if (c === ')' || c === ']' || c === '}') {
      const opener = open.pop();
      if (opener === undefined) return null;
      const expected = tokens[opener]!.kind === 'function' ? ')' : CLOSER[tokens[opener]!.kind];
      if (c !== expected) return null;
      tokens[opener]!.close = tokens.length;
      push(c, position + 1);
    } else if (c === ':' || c === ';' || c === ',') {
      push(c, position + 1);
    } else {
      push('delim', position + 1);
    }
  }
  return open.length > 0 ? null : tokens;
}

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n';
}

function isNameCharacter(c: string): boolean {
  return /^[-\w\u0080-￿]$/.test(c);
}

function isNameStart(c: string): boolean {
  return /^[a-zA-Z_\u0080-￿]$/.test(c);
}

/** "Would start an ident sequence", without escapes. */
function startsName(input: string, at: number): boolean {
  if (input[at] !== '-') return isNameStart(input[at] ?? '');
  return input[at + 1] === '-' || isNameStart(input[at + 1] ?? '');
}

/** "Would start a number". */
function startsNumber(input: string, at: number): boolean {
  let i = at;
  if (input[i] === '+' || input[i] === '-') i += 1;
  if (input[i] === '.') i += 1;
  return /^\d$/.test(input[i] ?? '');
}

/** Position after the closing quote, or -1 when a newline or the end comes first. */
function stringEnd(input: string, start: number): number {
  for (let i = start + 1; i < input.length; i += 1) {
    if (input[i] === input[start]) return i + 1;
    if (input[i] === '\n') return -1;
  }
  return -1;
}
