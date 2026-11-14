/**
 * `useGoChord` in isolation: no App, no DOM. Availability is a plain function
 * argument and the clock is the shared fake UI clock, so the chord window, the
 * grace window and the offered second keys are exercised directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useGoChord } from '../../src/composables/useGoChord';
import type { ActionId } from '../../src/lib/action-registry';
import { useUiTestClock } from '../support/timers';

const WINDOW_MS = 1500;
const GRACE_MS = 600;
const key = (value: string, init: Partial<KeyboardEvent> = {}): KeyboardEvent => ({ key: value, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...init }) as KeyboardEvent;

beforeEach(useUiTestClock);
afterEach(() => { vi.useRealTimers(); });

function setup(available: (id: ActionId) => boolean = () => true) {
  const scope = effectScope();
  const chord = scope.run(() => useGoChord({ actionAvailable: available }))!;
  return { chord, stop: () => scope.stop() };
}

describe('useGoChord', () => {
  it('arms on g, lapses after the window, then swallows for the grace window only', () => {
    const { chord, stop } = setup();
    expect(chord.goPending.value).toBe(false);
    chord.armGo();
    expect(chord.goPending.value).toBe(true);
    expect(chord.isArmed()).toBe(true);
    vi.advanceTimersByTime(WINDOW_MS - 1);
    expect(chord.goPending.value).toBe(true);
    vi.advanceTimersByTime(1);
    expect(chord.goPending.value).toBe(false);
    expect(chord.isArmed()).toBe(false);
    expect(chord.inGraceWindow()).toBe(true);
    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(chord.inGraceWindow()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(chord.inGraceWindow()).toBe(false);
    stop();
  });

  it('re-arming restarts the window and cancel clears pending and grace', () => {
    const { chord, stop } = setup();
    chord.armGo();
    vi.advanceTimersByTime(WINDOW_MS - 100);
    chord.armGo();
    vi.advanceTimersByTime(WINDOW_MS - 100);
    expect(chord.goPending.value).toBe(true);
    vi.advanceTimersByTime(100);
    expect(chord.inGraceWindow()).toBe(true);
    chord.cancelGo();
    expect(chord.goPending.value).toBe(false);
    expect(chord.isArmed()).toBe(false);
    expect(chord.inGraceWindow()).toBe(false);
    // Nothing fires after a cancel.
    vi.advanceTimersByTime(WINDOW_MS + GRACE_MS);
    expect(chord.inGraceWindow()).toBe(false);
    stop();
  });

  it('endGoGrace ends only the grace window', () => {
    const { chord, stop } = setup();
    chord.armGo();
    vi.advanceTimersByTime(WINDOW_MS);
    expect(chord.inGraceWindow()).toBe(true);
    chord.endGoGrace();
    expect(chord.inGraceWindow()).toBe(false);
    stop();
  });

  it('offers Done always and every other target only while it is available', () => {
    const open = new Set<ActionId>(['trash']);
    const { chord, stop } = setup((id) => open.has(id));
    expect(chord.goTargetFor(key('e'))?.id).toBe('done');
    expect(chord.goTargetFor(key('t'))?.id).toBe('trash');
    expect(chord.goTargetFor(key('d'))).toBeUndefined();
    expect(chord.goTargetFor(key('h'))).toBeUndefined();
    expect(chord.goTargetFor(key('a'))).toBeUndefined();
    expect(chord.isGoSecondKey(key('t'))).toBe(true);
    expect(chord.isGoSecondKey(key('d'))).toBe(false);
    open.add('drafts');
    expect(chord.goTargetFor(key('d'))?.id).toBe('drafts');
    stop();
  });

  it('a modified, shifted or composing key is never a second key', () => {
    const { chord, stop } = setup();
    for (const init of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { isComposing: true }]) {
      expect(chord.goTargetFor(key('e', init))).toBeUndefined();
    }
    expect(chord.goTargetFor(key('x'))).toBeUndefined();
    stop();
  });

  it('words the hint from the targets on offer, in chord order', () => {
    const all = setup();
    expect(all.chord.goHintLabel.value).toBe('g pressed. Press E for Done, T for Trash, D for Drafts, H for Reminders or A for Account, Escape to cancel.');
    all.stop();
    const some = setup((id) => id === 'trash');
    expect(some.chord.goHintLabel.value).toBe('g pressed. Press E for Done or T for Trash, Escape to cancel.');
    some.stop();
    const gmailless = setup(() => false);
    expect(gmailless.chord.goHintLabel.value).toBe('g pressed. Press E for Done, Escape to cancel.');
    gmailless.stop();
  });
});
