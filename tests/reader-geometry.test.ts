import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Reader and composer geometry contracts (DESIGN.md "Layout geometry").
 *
 * These tests read the declared CSS, not a render: they prove the numbers
 * agree (reader text on the 50px content inset, right edge on 24px, docked
 * and undocked composer margins equal, skeleton pitch equals the collapsed
 * message pitch). They do not prove how a browser lays the result out.
 */

const css = readFileSync('src/assets/style.css', 'utf8');
const replyComposerSfc = readFileSync('src/components/ReplyComposer.vue', 'utf8');
const chooserSfc = readFileSync('src/components/AttachmentChooser.vue', 'utf8');
const chooserCss = chooserSfc.slice(chooserSfc.indexOf('<style scoped>') + '<style scoped>'.length, chooserSfc.indexOf('</style>'));
const replyComposerCss = replyComposerSfc.slice(replyComposerSfc.indexOf('<style scoped>') + '<style scoped>'.length, replyComposerSfc.indexOf('</style>'));

const ROOT_FONT_PX = 16;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Selector lists of every flat rule, with its body. Nested at-rules are skipped. */
function rulesOf(source: string): Array<{ selectors: string[]; body: string }> {
  const out: Array<{ selectors: string[]; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stripComments(source))) !== null) {
    out.push({ selectors: (match[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' ')), body: match[2] ?? '' });
  }
  return out;
}

/** Declarations of every rule whose selector list contains exactly `selector` (later wins). */
function declarationsOf(source: string, selector: string): Record<string, string> {
  const decls: Record<string, string> = {};
  for (const rule of rulesOf(source)) {
    if (!rule.selectors.includes(selector)) continue;
    for (const part of rule.body.split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      decls[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
    }
  }
  return decls;
}

function hasRule(source: string, selector: string): boolean {
  return rulesOf(source).some((rule) => rule.selectors.includes(selector));
}

function rootToken(name: string): string {
  const value = declarationsOf(css, ':root')[name];
  if (value === undefined) throw new Error(`missing :root token ${name}`);
  return value;
}

/** Replaces every var(--token) with its :root value, recursively. */
function resolveVars(value: string): string {
  let current = value;
  for (let i = 0; i < 8 && /var\(--[\w-]+\)/.test(current); i += 1) {
    current = current.replace(/var\((--[\w-]+)\)/g, (_all, name: string) => rootToken(name));
  }
  return current;
}

/** Evaluates a px/rem length or calc() of them to px. */
function px(value: string | undefined): number {
  if (value === undefined) throw new Error('missing length');
  const expression = resolveVars(value)
    .replace(/(-?[\d.]+)rem/g, (_all, n: string) => `(${Number(n) * ROOT_FONT_PX})`)
    .replace(/(-?[\d.]+)px/g, '$1')
    .replace(/calc/g, '');
  if (!/^[\d\s+\-*/().]+$/.test(expression)) throw new Error(`cannot evaluate "${value}"`);
  return Function(`"use strict"; return (${expression});`)() as number;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (current) parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** Expands a 1-4 value box shorthand to resolved px [top, right, bottom, left]. */
function box(value: string | undefined): [number, number, number, number] {
  if (value === undefined) throw new Error('missing box shorthand');
  const v = splitTopLevel(value).map(px) as number[];
  const [a = 0, b = 0, c = 0, d = 0] = v;
  if (v.length === 1) return [a, a, a, a];
  if (v.length === 2) return [a, b, a, b];
  if (v.length === 3) return [a, b, c, b];
  return [a, b, c, d];
}

describe('reader and composer geometry (declared CSS)', () => {
  it('documents the content inset tokens on :root', () => {
    expect(rootToken('--content-inset')).toBe('50px');
    expect(rootToken('--content-inset-end')).toBe('24px');
    expect(rootToken('--message-row-height')).toBe('calc(var(--type-body) * 2)');
  });

  it('gives the reader pane no side padding, so the scroller owns the inset', () => {
    const pane = declarationsOf(css, '.reader-pane');
    const [, right, bottom, left] = box(pane.padding);
    expect(pane.padding).not.toContain('0.75rem');
    expect(left).toBe(0);
    expect(right).toBe(0);
    // A docked composer already brings its own 12px bottom margin.
    expect(bottom).toBe(0);
  });

  it('puts the scroller padding on the inset tokens', () => {
    const scroll = declarationsOf(css, '.reader-scroll');
    expect(scroll['padding-inline']).toBe('var(--content-inset) var(--content-inset-end)');
  });

  it('keeps the message fill 6px from the pane edges while its text stays on 50px and 24px', () => {
    const inset = px('var(--content-inset)');
    const insetEnd = px('var(--content-inset-end)');
    const [, marginEnd, , marginStart] = box(declarationsOf(css, '.messages').margin);
    const [, paddingEnd, , paddingStart] = box(declarationsOf(css, '.message').padding);
    // Fill edges, measured from the pane edge (the scroller padding is the origin).
    expect(inset + marginStart).toBe(6);
    expect(insetEnd + marginEnd).toBe(6);
    // Text edges.
    expect(inset + marginStart + paddingStart).toBe(inset);
    expect(insetEnd + marginEnd + paddingEnd).toBe(insetEnd);
  });

  it('starts the collapsed sender, expanded body, signature and Details on one x', () => {
    const toggle = declarationsOf(css, '.message-toggle');
    const [, toggleRight, , toggleLeft] = box(toggle.padding);
    expect(toggleLeft).toBe(0);
    expect(toggleRight).toBe(0);
    const summary = declarationsOf(css, '.message-details summary');
    expect(summary['margin-left']).toBeUndefined();
    for (const selector of ['.message-body', '.message-trail']) {
      const [, , , marginLeft] = box(declarationsOf(css, selector).margin);
      expect(marginLeft, selector).toBe(0);
    }
    // The quote toggle is a ghost button: its LABEL (button padding included) is on that x.
    const [, , , quoteMargin] = box(declarationsOf(css, '.message-quote-toggle').margin);
    expect(quoteMargin + box(declarationsOf(css, ':where(button)').padding)[3]).toBe(0);
  });

  it('lands the selection-scope note and the in-pane recovery banner on 50px and 24px', () => {
    const scope = box(declarationsOf(css, '.reader-selection-scope').margin);
    expect([scope[3], scope[1]]).toEqual([50, 24]);
    // The old override assumed the 12px pane padding and zeroed the banner inset.
    expect(hasRule(css, '.reader-pane .recovery-banner')).toBe(false);
    const banner = box(declarationsOf(css, '.recovery-banner').padding);
    expect([banner[3], banner[1]]).toEqual([50, 24]);
  });

  it('docks the card and the reply composer on the same inline margins as the undocked card', () => {
    const undocked = box(declarationsOf(css, '.compose-card').margin);
    expect([undocked[3], undocked[1]]).toEqual([50, 24]);

    const dockedDecl = declarationsOf(css, '.reader-pane > .compose-card');
    const docked = box(dockedDecl.margin ?? declarationsOf(css, '.compose-card').margin);
    expect(docked).toEqual(undocked);
    expect(dockedDecl['max-height']).toBe('60%');
    expect(dockedDecl['border-radius']).toBe('6px');

    const reply = declarationsOf(replyComposerCss, '.reply-composer');
    const replyMargin = box(reply.margin);
    expect([replyMargin[3], replyMargin[1], replyMargin[2]]).toEqual([undocked[3], undocked[1], undocked[2]]);
    expect(reply['max-height']).toBe('60%');
  });

  it('sizes each skeleton row to the real collapsed message pitch from the shared row height', () => {
    expect(css).not.toContain('1.4em');
    expect(declarationsOf(css, '.message-toggle')['min-height']).toBe('var(--message-row-height)');

    const skeleton = declarationsOf(css, '.reader-skeleton');
    expect(px(skeleton.gap)).toBe(0);

    const row = declarationsOf(css, '.reader-skeleton-row');
    expect(row.height).toContain('var(--message-row-height)');

    const message = declarationsOf(css, '.message');
    const [paddingTop, , paddingBottom] = box(message.padding);
    const borderTop = px(message['border-top']?.split(' ')[0]);
    const pitch = borderTop + paddingTop + px('var(--message-row-height)') + paddingBottom + px(message['margin-bottom']);
    expect(px(row.height)).toBe(pitch);
  });

  it('gives the focused active message toggle its own non-lavender ring, so active and focused are told apart', () => {
    const ring = declarationsOf(css, '.message.message-active .message-toggle:focus-visible');
    // The 3px lavender bar stays the only "active" signal (One Signal Rule); keyboard focus is Paper White.
    expect(ring.outline).toBe('2px solid var(--text-primary)');
    expect(ring['outline-offset']).toBe('1px');
    expect(ring.outline).not.toContain('focus-accent');
    expect(declarationsOf(css, '.message.message-active')['box-shadow']).toBe('inset 3px 0 0 var(--focus-accent)');
  });

  it('lays the loading line out so the first skeleton row sits where the first message will (no jump)', () => {
    // The skeleton adds no margin of its own: the subject (or its bar) and the meta slot decide where rows start.
    expect(px(declarationsOf(css, '.reader-skeleton')['margin-top'] ?? '0px')).toBe(0);
    // Overlay variant: the line is out of flow and centred on the first row's toggle box.
    const overlay = declarationsOf(css, '.reader-loading-stage.is-overlay > .reader-loading-line');
    expect(overlay.position).toBe('absolute');
    const message = declarationsOf(css, '.message');
    const rowTop = px(message['border-top']?.split(' ')[0]) + box(message.padding)[0];
    expect(px(overlay.top)).toBe(rowTop);
    expect(px(overlay.height)).toBe(px('var(--message-row-height)'));
    // The subject placeholder is an h2 with the real subject's class, so margins and line box match by construction;
    // the bar only paints inside that line box.
    const bar = declarationsOf(css, '.reader-skeleton-subject');
    expect(px(bar.height)).toBeLessThanOrEqual(px(declarationsOf(css, '.reader-subject')['font-size']) * Number(rootToken('--leading-headline')));
    expect(bar.margin ?? '0').toMatch(/^0/);
  });

  it('gives the Details labels one fixed column, so From, To, Cc and Sent values share one x', () => {
    const label = declarationsOf(css, '.message-field-label');
    expect(label.flex).toBe('0 0 3rem');
    expect(declarationsOf(css, '.message-field').display).toBe('flex');
    // Wide enough for the longest label ("Sent") at the shell size with room to spare.
    expect(px(label.flex?.split(' ')[2])).toBeGreaterThanOrEqual(48);
  });

  it('uses ONE inner padding for the reply composer and the new-message card, docked or not', () => {
    expect(box(rootToken('--composer-padding'))).toEqual([12, 16, 16, 16]);
    expect(declarationsOf(css, '.compose-card').padding).toBe('var(--composer-padding)');
    expect(declarationsOf(replyComposerCss, '.composer').padding).toBe('var(--composer-padding)');
  });

  it('sizes the undocked new-message card to its content instead of the whole column', () => {
    const card = declarationsOf(css, '.compose-card');
    expect(card.flex).toBe('0 1 auto');
    // Still scrolls instead of overflowing when the editor is taller than the column.
    expect(card['overflow-y']).toBe('auto');
    expect(card['min-height']).toBe('0');
    expect(declarationsOf(css, '.reader-pane > .compose-card').flex).toBe('0 0 auto');
  });

  it('does not indent the attachment chooser lists past the text above them', () => {
    const list = declarationsOf(chooserCss, 'ul');
    expect(list['padding-inline-start'] ?? list.padding).toBe('0');
  });

  it('puts the Show quoted text label on the 50px text edge by pulling its 8px button padding into the gap', () => {
    const toggle = declarationsOf(css, '.message-quote-toggle');
    expect(box(toggle.margin)[3]).toBe(-8);
    // The ghost default is `4px 8px`: the negative margin is exactly that padding.
    expect(box(declarationsOf(css, ':where(button)').padding)[3]).toBe(8);
  });
});
