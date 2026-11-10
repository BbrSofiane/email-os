import { describe, expect, it } from 'vitest';
import { revealDelta } from '../src/lib/reveal-in-view';

describe('revealDelta', () => {
  const view = { top: 100, bottom: 300 };
  it('is 0 when the item is already fully in view', () => {
    expect(revealDelta(view, { top: 120, bottom: 280 })).toBe(0);
    expect(revealDelta(view, { top: 100, bottom: 300 })).toBe(0);
  });
  it('scrolls down just enough to bring the bottom edge of a short item in', () => {
    expect(revealDelta(view, { top: 180, bottom: 340 })).toBe(40);
  });
  it('scrolls up just enough to bring the top edge in', () => {
    expect(revealDelta(view, { top: 70, bottom: 150 })).toBe(-30);
  });
  it('aligns the top of an item taller than the view, so its start shows', () => {
    expect(revealDelta(view, { top: 250, bottom: 600 })).toBe(150);
    expect(revealDelta(view, { top: 20, bottom: 400 })).toBe(-80);
  });
});
