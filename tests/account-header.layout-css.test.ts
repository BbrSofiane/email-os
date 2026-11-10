import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source-level pins for the header width rule (DESIGN.md gap 18). jsdom does not
 * lay anything out, so these tests prove only that the rules exist; the measured
 * result at 1030px is recorded in the critique file, not asserted here.
 */
const css = readFileSync('src/assets/style.css', 'utf8');
/** Every declaration block for the selector (a selector can open one rule and sit in a grouped one), joined. */
const block = (selector: string): string => {
  const matches = [...css.matchAll(new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`, 'g'))];
  if (!matches.length) throw new Error(`Missing rule ${selector}`);
  return matches.map((match) => match[1]!).join('\n');
};

describe('header width rule (CSS source)', () => {
  it('gives the tab column a floor so the trail cannot crush the active tab', () => {
    expect(block('.app-header')).toMatch(/grid-template-columns:\s*50px minmax\(min\(var\(--header-tabs-floor\), 100%\), 1fr\) minmax\(0, auto\)/);
    expect(css).toMatch(/--header-tabs-floor:\s*max\(/);
  });

  it('builds the floor from what is really in the strip: Inbox, a saved tab and each filter chip', () => {
    const header = block('.app-header');
    expect(header).toMatch(/--tab-inbox:\s*4\.5rem/);
    expect(header).toMatch(/--tab-saved:\s*9rem/);
    expect(header).toMatch(/--header-chip:\s*4\.75rem/);
    expect(header).toMatch(/--header-tabs-floor:\s*max\(10rem, calc\(var\(--tab-inbox\) \+ var\(--floor-saved\) \+ var\(--floor-filter\)\)\)/);
    // Two tabs add the saved tab; each chip adds a chip. These are :has() rules on the header.
    expect(css).toMatch(/\.app-header:has\(\.split-nav > \.split-tab \+ \.split-tab\)\s*\{[^}]*--floor-saved:\s*calc\(var\(--tabs-gap\) \+ var\(--tab-saved\)\)/);
    expect(css).toMatch(/\.app-header:has\(\.header-filter\)\s*\{[^}]*--floor-filter:/);
    expect(css).toMatch(/\.app-header:has\(\.header-filter ~ \.header-filter\)\s*\{[^}]*--floor-filter:/);
  });

  it('never shrinks a tab: the tab and the nav keep their size, and a saved-tab label stops at 12ch with an ellipsis', () => {
    expect(block('.split-tab')).toMatch(/flex:\s*0 0 auto/);
    expect(block('.split-nav')).toMatch(/flex:\s*0 0 auto/);
    const label = block('.split-label');
    expect(label).toMatch(/max-width:\s*12ch/);
    expect(label).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('collapses the read-only hint to its link at 1100px and below, so it gives up width before the tabs', () => {
    const query = css.match(/@media \(max-width: 1100px\)\s*\{([\s\S]*?)\n\}/);
    expect(query).not.toBeNull();
    expect(query![1]).toMatch(/\.access-hint \.hint-text\s*\{[^}]*position:\s*absolute/);
    expect(query![1]).toMatch(/\.access-hint \.hint-text\s*\{[^}]*clip-path:\s*inset\(50%\)/);
    expect(block('.access-hint .header-link')).toMatch(/flex:\s*none/);
  });

  it('balances the contact pane line so it never leaves a one-word straggler', () => {
    expect(block('.contact-unknown')).toMatch(/text-wrap:\s*balance/);
  });

  it('lets notes give up width before the glyphs, the preview tag first and the status note last', () => {
    expect(block('.header-glyph')).toMatch(/flex:\s*0 0 auto/);
    expect(block('.header-note')).toMatch(/flex:\s*0 1 auto/);
    expect(block('.preview-tag')).toMatch(/flex-shrink:\s*4/);
    expect(block('.header-note.account-status-note')).toMatch(/flex-shrink:\s*1/);
  });
});
