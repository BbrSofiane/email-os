import { describe, expect, it } from 'vitest';
import { bodyNeedsMonospace } from '../src/lib/message-body-format';

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
