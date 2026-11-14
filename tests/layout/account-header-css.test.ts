import { describe, expect, it } from 'vitest';
import { css } from '../support/css-contract';

/**
 * Source-level pins for the header width rule (DESIGN.md gap 18). jsdom does not
 * lay anything out, so these tests prove only that the rules exist; the measured
 * result at 1030px is recorded in the critique file, not asserted here.
 */
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

/** The text of one `@media (max-width: 1100px)` block, so a rule can be pinned to the narrow breakpoint. */
const narrow = (): string => {
  const query = [...css.matchAll(/@media \(max-width: 1100px\)\s*\{([\s\S]*?)\n\}/g)].map((match) => match[1]!).join('\n');
  if (!query) throw new Error('Missing the 1100px query');
  return query;
};

describe('1030px header: the one note that matters yields last (CSS source; jsdom cannot measure layout)', () => {
  it('shortens the Preview tag at 1100px and below, so it yields before the read-only hint and the status words', () => {
    expect(narrow()).toMatch(/\.preview-detail\s*\{[^}]*display:\s*none/);
    expect(narrow()).toMatch(/\.preview-tag\s*\{[^}]*min-width:\s*0/);
  });

  it('drops the Preview tag to its accessible text while an account note or the read-only hint needs the room', () => {
    const rule = narrow().match(/\.app-header:has\(([^)]*\.account-status-note:not\(\.visually-hidden\)[^)]*)\) \.preview-tag\s*\{([^}]*)\}/);
    expect(rule, 'a :has() rule on the header').not.toBeNull();
    expect(rule![1]).toMatch(/\.access-hint/);
    expect(rule![2]).toMatch(/position:\s*absolute/);
    expect(rule![2]).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(rule![2]).toMatch(/margin:\s*0/);
  });

  it('keeps the Review access link whole: the collapsed hint never shrinks', () => {
    expect(narrow()).toMatch(/\.access-hint\s*\{[^}]*flex-shrink:\s*0/);
    expect(block('.access-hint .header-link')).toMatch(/flex:\s*none/);
  });

  it('keeps the lead words and the action link of the status note whole; only the detail ellipsizes', () => {
    const note = block('.header-note.account-status-note');
    expect(note).toMatch(/display:\s*grid/);
    expect(note).toMatch(/grid-template-columns:\s*minmax\(0, max-content\) minmax\(0, max-content\) max-content max-content/);
    // The note's own floor is its min-content: lead + link, because the detail track's minimum is 0.
    expect(note).toMatch(/min-width:\s*min-content/);
    expect(block('.account-status-note .note-text')).toMatch(/display:\s*contents/);
    const detail = block('.account-status-note .note-detail');
    expect(detail).toMatch(/min-width:\s*0/);
    expect(detail).toMatch(/overflow:\s*hidden/);
    expect(detail).toMatch(/text-overflow:\s*ellipsis/);
    expect(detail).toMatch(/white-space:\s*pre/);
    expect(block('.account-status-note .header-link')).toMatch(/flex:\s*none|white-space:\s*nowrap/);
  });

  it('never clips the lead of a failure or an expired sign-in (the notes that matter)', () => {
    const rule = css.match(/\.header-note\.account-status-note\.tone-danger,\s*\.header-note\.account-status-note\.tone-warning\s*\{([^}]*)\}/);
    expect(rule, 'a rule for the danger and warning notes').not.toBeNull();
    expect(rule![1]).toMatch(/grid-template-columns:\s*max-content minmax\(0, max-content\) max-content max-content/);
  });
});

describe('the empty line echoes the notice tone (CSS source)', () => {
  it('colours the sentence Coral Fault for a failure and Amber Notice for an expired sign-in, with the same tokens as the header note', () => {
    expect(block('.list-state.tone-danger')).toMatch(/color:\s*var\(--danger\)/);
    expect(block('.list-state.tone-warning')).toMatch(/color:\s*var\(--warning\)/);
    expect(block('.header-note.tone-danger')).toMatch(/color:\s*var\(--danger\)/);
    expect(block('.header-note.tone-warning')).toMatch(/color:\s*var\(--warning\)/);
  });

  it('leaves the neutral line Ash and does not recolour the action link or the hint', () => {
    expect(block('.list-state')).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(css).not.toMatch(/\.list-state\.tone-neutral/);
    expect(block('.list-state-hint')).toMatch(/color:\s*var\(--text-secondary\)/);
    expect(block('.inline-action')).toMatch(/color:\s*var\(--text-primary\)/);
  });
});

describe('the contact column collapses with no rows (CSS source)', () => {
  it('drops the third grid column at 1000px and above while collapsed, so the list takes the width', () => {
    const wide = css.match(/@media \(min-width: 1000px\)\s*\{([\s\S]*?)\n\}/);
    expect(wide).not.toBeNull();
    expect(wide![1]).toMatch(/\.app-main\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\) var\(--contact-width\)/);
    expect(wide![1]).toMatch(/\.app-main\.contact-collapsed\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)\s*;/);
  });
});
