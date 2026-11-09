import { describe, expect, it } from 'vitest';
import { MESSAGE_SNIPPET_MAX, clipText, messageSnippet, quotedPreview } from '../src/lib/message-snippet';

/** A high or low surrogate that is not part of a pair. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
const E_ACUTE = 'e\u0301';

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

describe('clipText', () => {
  it('returns text that fits whole, and ASCII cut exactly at the cap', () => {
    expect(clipText('hello', 5)).toBe('hello');
    expect(clipText('hello', 10)).toBe('hello');
    expect(clipText('hello world', 5)).toBe('hello');
    expect(clipText('', 5)).toBe('');
  });

  it('never splits a surrogate pair', () => {
    const text = `ab${'\u{1F600}'}cd`;
    // The cap falls between the two halves of the emoji.
    expect(clipText(text, 3)).toBe('ab');
    expect(clipText(text, 4)).toBe(`ab${'\u{1F600}'}`);
    for (let max = 0; max <= text.length; max += 1) expect(clipText(text, max)).not.toMatch(LONE_SURROGATE);
  });

  it('keeps a ZWJ sequence whole or drops it whole', () => {
    const text = `x${FAMILY}y`;
    expect(FAMILY.length).toBe(11);
    expect(clipText(text, 6)).toBe('x');
    expect(clipText(text, 11)).toBe('x');
    expect(clipText(text, 12)).toBe(`x${FAMILY}`);
    for (let max = 0; max <= text.length; max += 1) {
      const out = clipText(text, max);
      expect(out).not.toMatch(LONE_SURROGATE);
      expect(['', 'x', `x${FAMILY}`, text]).toContain(out);
    }
  });

  it('keeps a base letter with its combining accent', () => {
    const text = `a${E_ACUTE}b`;
    expect(clipText(text, 2)).toBe('a');
    expect(clipText(text, 3)).toBe(`a${E_ACUTE}`);
  });

  it('never exceeds the cap in UTF-16 units', () => {
    const text = `${'\u{1F600}'.repeat(10)}${E_ACUTE.repeat(10)}`;
    for (let max = 0; max <= text.length; max += 1) expect(clipText(text, max).length).toBeLessThanOrEqual(max);
  });

  it('falls back to code points when Intl.Segmenter is missing, never leaving a lone surrogate', () => {
    const original = Intl.Segmenter;
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true, writable: true });
    try {
      const text = `ab${'\u{1F600}'}cd`;
      expect(clipText(text, 3)).toBe('ab');
      expect(clipText(text, 4)).toBe(`ab${'\u{1F600}'}`);
      expect(clipText('hello world', 5)).toBe('hello');
    } finally {
      Object.defineProperty(Intl, 'Segmenter', { value: original, configurable: true, writable: true });
    }
  });
});

describe('messageSnippet clipping', () => {
  it('does not split an emoji at the cut', () => {
    const body = `${'a'.repeat(MESSAGE_SNIPPET_MAX - 1)}\u{1F600}tail`;
    const out = messageSnippet(body);
    expect(out).toBe(`${'a'.repeat(MESSAGE_SNIPPET_MAX - 1)}…`);
    expect(out).not.toMatch(LONE_SURROGATE);
  });

  it('keeps combining accents and ZWJ sequences whole', () => {
    expect(messageSnippet(`${'a'.repeat(MESSAGE_SNIPPET_MAX - 1)}${E_ACUTE}b`)).toBe(`${'a'.repeat(MESSAGE_SNIPPET_MAX - 1)}…`);
    const out = messageSnippet(`${'a'.repeat(MESSAGE_SNIPPET_MAX - 3)}${FAMILY}`);
    expect(out).not.toMatch(LONE_SURROGATE);
    expect(out).toBe(`${'a'.repeat(MESSAGE_SNIPPET_MAX - 3)}…`);
  });

  it('leaves an all-ASCII body exactly as before', () => {
    const word = 'word '.repeat(100);
    expect(messageSnippet(word)).toBe(`${word.slice(0, MESSAGE_SNIPPET_MAX).trimEnd()}…`);
  });
});

describe('quotedPreview', () => {
  it('returns a short body whole, without an ellipsis', () => {
    expect(quotedPreview('Ship it > <b>Friday</b>\nsecond line')).toBe('Ship it > <b>Friday</b>\nsecond line');
    expect(quotedPreview('a'.repeat(200))).toBe('a'.repeat(200));
  });

  it('cuts a long ASCII body at 200 with an ellipsis', () => {
    const body = 'x'.repeat(500);
    expect(quotedPreview(body)).toBe(`${'x'.repeat(200)}…`);
    expect(quotedPreview(body, 10)).toBe(`${'x'.repeat(10)}…`);
  });

  it('trims leading blank lines and trailing whitespace', () => {
    expect(quotedPreview('\n\n  \nHello\n\n')).toBe('Hello');
  });

  it('is empty for an empty or blank body', () => {
    expect(quotedPreview('')).toBe('');
    expect(quotedPreview(' \n\t ')).toBe('');
  });

  it('previews only the prose when a localized quote trails it', () => {
    expect(quotedPreview('Merci, c’est bon.\n\nLe jeudi 6 nov. 2026, Ada a écrit :\n> Peut-on livrer ?\n> Vendredi.')).toBe('Merci, c’est bon.');
    expect(quotedPreview('Danke.\n-- \nAda\n\nAm 06.11.2026 schrieb Bob:\n> hi')).toBe('Danke.');
  });

  it('previews something for a body that is all quote', () => {
    expect(quotedPreview('> a\n> b')).toBe('> a\n> b');
    expect(quotedPreview('On Thu, Ada wrote:\n> hi')).toBe('On Thu, Ada wrote:\n> hi');
  });

  it('never splits an emoji, a ZWJ family or a combining accent at the cap', () => {
    for (const unit of ['\u{1F600}', FAMILY, E_ACUTE]) {
      for (let pad = 190; pad <= 200; pad += 1) {
        const out = quotedPreview(`${'a'.repeat(pad)}${unit.repeat(5)}tail`);
        expect(out).not.toMatch(LONE_SURROGATE);
        expect(out.endsWith('…')).toBe(true);
        expect(out.length).toBeLessThanOrEqual(201);
        expect(out.replace(/…$/, '')).toMatch(/^a+(?:\u{1F600}|\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}|e\u0301)*$/u);
      }
    }
  });

  it('does not touch the characters it keeps', () => {
    expect(quotedPreview('<img src=x onerror=1>\n> q')).toBe('<img src=x onerror=1>\n> q');
  });
});

