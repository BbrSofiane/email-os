import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source-level pins for the header width rule (DESIGN.md gap 18). jsdom does not
 * lay anything out, so these tests prove only that the rules exist; the measured
 * result at 1030px is recorded in the critique file, not asserted here.
 */
const css = readFileSync('src/assets/style.css', 'utf8');
const block = (selector: string): string => {
  const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing rule ${selector}`);
  return match[1]!;
};

describe('header width rule (CSS source)', () => {
  it('gives the tab column a floor so the trail cannot crush the active tab', () => {
    expect(block('.app-header')).toMatch(/grid-template-columns:\s*50px minmax\(min\(var\(--header-tabs-floor\), 100%\), 1fr\) minmax\(0, auto\)/);
    expect(css).toMatch(/--header-tabs-floor:\s*10rem/);
  });

  it('lets notes give up width before the glyphs, the preview tag first and the status note last', () => {
    expect(block('.header-glyph')).toMatch(/flex:\s*0 0 auto/);
    expect(block('.header-note')).toMatch(/flex:\s*0 1 auto/);
    expect(block('.preview-tag')).toMatch(/flex-shrink:\s*4/);
    expect(block('.header-note.account-status-note')).toMatch(/flex-shrink:\s*1/);
  });
});
