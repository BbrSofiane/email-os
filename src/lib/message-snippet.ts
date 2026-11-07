/** Longest snippet kept for a collapsed reader message (the row clips it further with CSS). */
export const MESSAGE_SNIPPET_MAX = 140;

/**
 * One-line plain-text preview of a message body for the collapsed reader row:
 * whitespace runs (including newlines) collapse to a single space, the result
 * is trimmed and cut at `max` characters with an ellipsis. An empty or
 * missing body gives `''`, so the row shows nothing rather than invented text.
 * The caller must render it with text interpolation only.
 */
export function messageSnippet(bodyText: string | null | undefined, max: number = MESSAGE_SNIPPET_MAX): string {
  const text = (bodyText ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}
