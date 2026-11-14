import { splitMessageBody } from './message-body-format';

/** Longest snippet kept for a collapsed reader message (the row clips it further with CSS). */
export const MESSAGE_SNIPPET_MAX = 140;
/** Longest read-only preview of the latest message in the reply composer. */
export const QUOTED_PREVIEW_MAX = 200;

/**
 * Cuts `text` to at most `max` UTF-16 units without splitting a character.
 * The cut falls on a grapheme-cluster boundary (`Intl.Segmenter`), so an emoji,
 * a ZWJ sequence or a letter with its combining accent is kept whole or dropped
 * whole. Where `Intl.Segmenter` is missing it falls back to code points, which
 * still never leaves a lone surrogate. The characters kept are never altered.
 */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const pieces: Iterable<string> = typeof Intl.Segmenter === 'function' ? segmentsOf(text) : text;
  let end = 0;
  for (const piece of pieces) {
    if (end + piece.length > max) break;
    end += piece.length;
  }
  return text.slice(0, end);
}

/** Lazy grapheme iterator: a long body is read only as far as the cap. */
function* segmentsOf(text: string): Generator<string> {
  for (const { segment } of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text)) yield segment;
}

/**
 * One-line plain-text preview of a message body for the collapsed reader row:
 * whitespace runs (including newlines) collapse to a single space, the result
 * is trimmed and cut at `max` characters with an ellipsis. An empty or
 * missing body gives `''`, so the row shows nothing rather than invented text.
 * The cut never splits an emoji or a combining sequence (`clipText`).
 * The caller must render it with text interpolation only.
 */
export function messageSnippet(bodyText: string | null | undefined, max: number = MESSAGE_SNIPPET_MAX): string {
  const text = (bodyText ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${clipText(text, max).trimEnd()}…`;
}

/**
 * Read-only preview of a message for the reply composer: the prose part of the
 * body (a trailing quote and the signature are left out; a body that is all
 * quote previews as it is), trimmed, cut at `max` without splitting a
 * character, and followed by `…` only when it was cut. Line breaks stay. The
 * caller must render it with text interpolation only, and never as draft text.
 */
export function quotedPreview(bodyText: string | null | undefined, max: number = QUOTED_PREVIEW_MAX): string {
  const prose = splitMessageBody(bodyText ?? '').main.trim();
  const clipped = clipText(prose, max);
  return clipped.length < prose.length ? `${clipped.trimEnd()}…` : prose;
}
