import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLongPressSelection } from '../../src/composables/useLongPressSelection';

function pointer(type: string, x: number, y: number, pointerType = 'touch'): PointerEvent {
  const event = new Event(type) as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: pointerType },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useLongPressSelection', () => {
  it('fires at 500ms and suppresses the following click', () => {
    vi.useFakeTimers();
    const toggle = vi.fn();
    const onFire = vi.fn();
    const press = useLongPressSelection(toggle, onFire);
    press.pointerdown(pointer('pointerdown', 10, 10));
    vi.advanceTimersByTime(499);
    expect(toggle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(press.consumeClick()).toBe(true);
  });

  it.each([
    { end: 'move' as const },
    { end: 'release' as const },
    { end: 'cancel' as const },
  ])('cancels on $end', ({ end }) => {
    vi.useFakeTimers();
    const toggle = vi.fn();
    const press = useLongPressSelection(toggle);
    press.pointerdown(pointer('pointerdown', 0, 0));
    if (end === 'move') press.pointermove(pointer('pointermove', 11, 0));
    if (end === 'release') press.pointerup(pointer('pointerup', 0, 0));
    if (end === 'cancel') press.pointercancel(pointer('pointercancel', 0, 0));
    vi.advanceTimersByTime(500);
    expect(toggle).not.toHaveBeenCalled();
  });

  it('ignores mouse pointers', () => {
    vi.useFakeTimers();
    const toggle = vi.fn();
    const press = useLongPressSelection(toggle);
    press.pointerdown(pointer('pointerdown', 0, 0, 'mouse'));
    vi.advanceTimersByTime(500);
    expect(toggle).not.toHaveBeenCalled();
  });
});
