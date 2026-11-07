import { describe, expect, it } from 'vitest';
import { MESSAGE_SNIPPET_MAX, messageSnippet } from '../src/lib/message-snippet';

describe('messageSnippet', () => {
  it('collapses whitespace runs and newlines to single spaces', () => {
    expect(messageSnippet('  Hello\n\n  world\t\tagain \r\n')).toBe('Hello world again');
  });

  it('keeps a body at the limit whole and cuts a longer one with an ellipsis', () => {
    const exact = 'a'.repeat(MESSAGE_SNIPPET_MAX);
    expect(messageSnippet(exact)).toBe(exact);
    const cut = messageSnippet('word '.repeat(100));
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(MESSAGE_SNIPPET_MAX + 1);
    expect(cut).not.toMatch(/\s…$/);
  });

  it('returns an empty string for empty, blank or missing bodies', () => {
    expect(messageSnippet('')).toBe('');
    expect(messageSnippet(' \n\t ')).toBe('');
    expect(messageSnippet(undefined)).toBe('');
    expect(messageSnippet(null)).toBe('');
  });

  it('leaves markup literal (callers render it as text)', () => {
    expect(messageSnippet('<b>hi</b>\n<script>x</script>')).toBe('<b>hi</b> <script>x</script>');
  });
});
