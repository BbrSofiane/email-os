import { describe, expect, it } from 'vitest';
import { bodyNeedsMonospace, splitMessageBody } from '../src/lib/message-body-format';

describe('bodyNeedsMonospace', () => {
  it('keeps plain prose proportional', () => {
    expect(bodyNeedsMonospace('Hi,\n\nThe sync fix is on track. Thanks > nothing.\n\nAda')).toBe(false);
    expect(bodyNeedsMonospace('')).toBe(false);
    expect(bodyNeedsMonospace('    one indented line only\nthen prose')).toBe(false);
    expect(bodyNeedsMonospace('a | b\nno second pipe line')).toBe(false);
  });

  it('uses monospace for quoted lines', () => {
    expect(bodyNeedsMonospace('Thanks\n\nOn Thu Ada wrote:\n> can we ship?')).toBe(true);
    expect(bodyNeedsMonospace('>quoted without a space')).toBe(true);
  });

  it('uses monospace for two consecutive indented lines or a tab block', () => {
    expect(bodyNeedsMonospace('Run:\n    $ pnpm test\n    ok')).toBe(true);
    expect(bodyNeedsMonospace('Run:\n\tfoo\n\tbar')).toBe(true);
    expect(bodyNeedsMonospace('    a\nprose\n    b')).toBe(false);
  });

  it('uses monospace for table-ish pipe lines', () => {
    expect(bodyNeedsMonospace('| step | owner |\n| merge | ada |')).toBe(true);
  });
});

describe('splitMessageBody', () => {
  const rejoin = (body: string): string => {
    const parts = splitMessageBody(body);
    return parts.main + (parts.signature ?? '') + (parts.quoted ?? '');
  };

  it('returns the body unchanged when there is no signature or trailing quote', () => {
    const body = 'Hi,\n\nThanks > nothing.\n\nAda';
    expect(splitMessageBody(body)).toEqual({ main: body, signature: null, quoted: null });
    expect(splitMessageBody('')).toEqual({ main: '', signature: null, quoted: null });
  });

  it('splits an attributed trailing quote and keeps the blank line with the prose', () => {
    const body = 'Shipping Friday.\n\nOn Thu, Ada wrote:\n> can we ship?\n> soon\n';
    expect(splitMessageBody(body)).toEqual({
      main: 'Shipping Friday.\n\n',
      signature: null,
      quoted: 'On Thu, Ada wrote:\n> can we ship?\n> soon\n',
    });
  });

  it('accepts a wrapped attribution, blank lines before the quote, and Original Message', () => {
    const wrapped = 'Yes.\nOn Thu, 6 Nov 2026 at 09:00, Ada Fixture <ada@example.test>\nwrote:\n\n> q';
    expect(splitMessageBody(wrapped).quoted).toBe('On Thu, 6 Nov 2026 at 09:00, Ada Fixture <ada@example.test>\nwrote:\n\n> q');
    const original = 'Yes.\n-----Original Message-----\n> q';
    expect(splitMessageBody(original)).toEqual({ main: 'Yes.\n', signature: null, quoted: '-----Original Message-----\n> q' });
  });

  it('splits a bare trailing run of two or more quoted lines but not a single one', () => {
    expect(splitMessageBody('Yes.\n> a\n> b').quoted).toBe('> a\n> b');
    expect(splitMessageBody('Yes.\n> a')).toEqual({ main: 'Yes.\n> a', signature: null, quoted: null });
  });

  it('keeps interleaved quotes in the prose', () => {
    const body = '> Are we on?\nYes.\n> And Friday?\nAlso yes.';
    expect(splitMessageBody(body)).toEqual({ main: body, signature: null, quoted: null });
  });

  it('splits a short RFC 3676 signature, with or without the trailing space', () => {
    expect(splitMessageBody('Thanks.\n-- \nAda\nExample Co')).toEqual({
      main: 'Thanks.\n',
      signature: '-- \nAda\nExample Co',
      quoted: null,
    });
    expect(splitMessageBody('Thanks.\n--\nAda').signature).toBe('--\nAda');
  });

  it('does not treat a long tail after the delimiter as a signature', () => {
    const tail = Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n');
    const body = `Intro.\n-- \n${tail}`;
    expect(splitMessageBody(body)).toEqual({ main: body, signature: null, quoted: null });
    const twelve = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    expect(splitMessageBody(`Intro.\n-- \n${twelve}`).signature).toBe(`-- \n${twelve}`);
  });

  it('orders main, signature, quoted and ignores a delimiter inside the quote', () => {
    const body = 'Thanks.\n-- \nAda\n\nOn Thu, Bob wrote:\n> hi\n> -- \n> Bob';
    const parts = splitMessageBody(body);
    expect(parts.main).toBe('Thanks.\n');
    expect(parts.signature).toBe('-- \nAda\n\n');
    expect(parts.quoted).toBe('On Thu, Bob wrote:\n> hi\n> -- \n> Bob');
  });

  it('never hides a body that is entirely quote', () => {
    const quoted = 'On Thu, Ada wrote:\n> can we ship?\n> soon';
    expect(splitMessageBody(quoted)).toEqual({ main: quoted, signature: null, quoted: null });
    const bare = '> a\n> b';
    expect(splitMessageBody(bare)).toEqual({ main: bare, signature: null, quoted: null });
    const sigOnly = '-- \nAda';
    expect(splitMessageBody(sigOnly)).toEqual({ main: sigOnly, signature: null, quoted: null });
  });

  it('is lossless for every shape, including CRLF and hostile markup', () => {
    const bodies = [
      'Hi\r\n\r\nOn Thu, Ada wrote:\r\n> <img src=x onerror=alert(1)>\r\n> more\r\n',
      'a\n-- \nsig\nOn x wrote:\n> q',
      'a\n\n\n> x\n> y\n\n\n',
      '<b>bold</b>\n--\n<script>1</script>',
      'only prose',
    ];
    for (const body of bodies) expect(rejoin(body)).toBe(body);
  });

  it('evaluates monospace on the prose part only', () => {
    const body = 'Short prose reply.\n\nOn Thu, Ada wrote:\n> a\n> b';
    expect(bodyNeedsMonospace(body)).toBe(true);
    expect(bodyNeedsMonospace(splitMessageBody(body).main)).toBe(false);
  });
});
