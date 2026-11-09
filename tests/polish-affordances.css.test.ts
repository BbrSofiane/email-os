import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  colourOf,
  contrastRatio,
  css,
  declarationListOf,
  declarationsOf,
  ruleIndexOf,
} from './css-contract';

/**
 * Polish pass (affordances and accessibility): contracts read from the declared
 * CSS and the token hex values. Ratios are computed from the tokens, not
 * sampled from a render.
 */

const SURFACE_RAISED = colourOf('var(--surface-raised)'); // Lifted Charcoal: composer card
const SURFACE_CONTACT = colourOf('var(--surface-contact)'); // Deep Umber: drawer behind the draft editor
const NON_TEXT_FLOOR = 3; // WCAG 1.4.11 non-text contrast

describe('composer field boundary (non-text contrast)', () => {
  it('keeps the old Seam underline under the 3:1 floor, which is why it was replaced', () => {
    expect(contrastRatio(colourOf('var(--divider)'), SURFACE_RAISED)).toBeLessThan(NON_TEXT_FLOOR);
  });

  it('draws the resting underline of the To, Cc and Subject rows in Graphite, which clears 3:1 on both composer surfaces', () => {
    const rest = declarationsOf(css, '.field-row .field-input');
    const underline = colourOf(rest['border-bottom-color']);
    expect(rest['border-bottom-color']).toBe('var(--icon-muted)');
    expect(contrastRatio(underline, SURFACE_RAISED)).toBeGreaterThanOrEqual(NON_TEXT_FLOOR); // docked and new-message card
    expect(contrastRatio(underline, SURFACE_CONTACT)).toBeGreaterThanOrEqual(NON_TEXT_FLOOR); // drafts drawer editor
    // The rest of the border stays invisible until hover.
    expect(rest['border']).toBe('1px solid transparent');
  });

  it('shows the full border in Graphite on hover and keeps Dusk Lavender plus the inner ring on keyboard focus', () => {
    expect(declarationsOf(css, '.field-row .field-input:hover:not(:disabled)')['border-color']).toBe('var(--icon-muted)');
    const focus = declarationsOf(css, '.field-row .field-input:focus-visible');
    expect(focus['border-color']).toBe('var(--focus-accent)');
    expect(focus['outline']).toBe('1px solid var(--focus-accent)');
    expect(focus['outline-offset']).toBe('-2px');
  });

  it('gives the body textarea the same boundary token, with the focus ring declared after it so it still wins', () => {
    const body = declarationsOf(css, '.field-textarea');
    expect(body['border-color']).toBe('var(--icon-muted)');
    expect(contrastRatio(colourOf(body['border-color']), SURFACE_RAISED)).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
    expect(declarationsOf(css, '.field-textarea:focus-visible')['border-color']).toBe('var(--focus-accent)');
    expect(ruleIndexOf(css, '.field-textarea:focus-visible')).toBeGreaterThan(ruleIndexOf(css, '.field-textarea'));
  });
});

describe('composer caveat toggle target', () => {
  const GLYPH = Number(/class="composer-caveat-toggle"[\s\S]*?<svg width="(\d+)"/.exec(readFileSync('src/components/DraftEditorCore.vue', 'utf8'))?.[1]);
  const length = (value: string | undefined): number => {
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value ?? '');
    if (!match) throw new Error(`not a px length: ${value}`);
    return Number(match[1]);
  };

  it('keeps the 14px glyph', () => {
    expect(GLYPH).toBe(14);
  });

  it('has a hit area of at least 24x24 around the glyph', () => {
    const toggle = declarationsOf(css, '.composer-caveat-toggle');
    const hit = GLYPH + 2 * length(toggle['padding']);
    expect(hit).toBeGreaterThanOrEqual(24);
  });

  it('does not grow the heading row: the layout box stays 18px (glyph + 2 x 2px) through an equal negative margin', () => {
    const toggle = declarationsOf(css, '.composer-caveat-toggle');
    const layout = GLYPH + 2 * length(toggle['padding']) + 2 * length(toggle['margin']);
    expect(layout).toBe(GLYPH + 2 * 2);
  });
});

describe('participant focus ring', () => {
  it('draws a 2px Dusk Lavender outline at a 1px offset with a small radius on :focus-visible', () => {
    const focus = declarationsOf(css, '.participant:focus-visible');
    expect(focus['outline']).toBe('2px solid var(--focus-accent)');
    expect(focus['outline-offset']).toBe('1px');
    expect(focus['border-radius']).toBe('4px');
  });
});

describe('Details summary glyph', () => {
  it('adds the CSS alt-text form (empty alt) right after the fallback, closed and open', () => {
    expect(declarationListOf(css, '.message-details summary::before')).toEqual([
      ['content', "'▸ '"],
      ['content', "'▸ ' / ''"],
    ]);
    expect(declarationListOf(css, '.message-details[open] summary::before')).toEqual([
      ['content', "'▾ '"],
      ['content', "'▾ ' / ''"],
    ]);
  });

  it('keeps the glyph Ash, never Graphite', () => {
    expect(declarationsOf(css, '.message-details summary')['color']).toBe('var(--text-secondary)');
  });
});
