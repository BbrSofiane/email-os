import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSwipeAction } from '../../src/composables/useSwipeAction';

function pointer(type: string, x: number, y: number, id = 1, pointerType = 'touch'): PointerEvent {
  const event = new Event(type) as PointerEvent;
  Object.defineProperties(event, {
    pointerType: { value: pointerType },
    pointerId: { value: id },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
}

function setup(available: (side: 'left' | 'right') => boolean = () => true) {
  const element = document.createElement('div');
  element.setPointerCapture = vi.fn();
  element.getBoundingClientRect = () => ({ width: 200 } as DOMRect);
  const commit = vi.fn();
  const swipe = useSwipeAction(() => element, available, commit);
  return { element, commit, swipe };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('useSwipeAction', () => {
  it('gives vertical movement to scrolling', () => {
    const { element, swipe } = setup();
    swipe.pointerdown(pointer('pointerdown', 20, 20));
    expect(swipe.dragging.value).toBe(false);
    swipe.pointermove(pointer('pointermove', 25, 40));
    expect(swipe.offset.value).toBe(0);
    expect(swipe.dragging.value).toBe(false);
    expect(element.setPointerCapture).not.toHaveBeenCalled();
  });

  it('tracks horizontal drags without transition until the gesture ends', () => {
    const { swipe } = setup();
    swipe.pointerdown(pointer('pointerdown', 20, 20));
    swipe.pointermove(pointer('pointermove', 29, 20));
    expect(swipe.dragging.value).toBe(false);
    swipe.pointermove(pointer('pointermove', 30, 20));
    expect(swipe.dragging.value).toBe(true);
    swipe.pointerup(pointer('pointerup', 30, 20));
    expect(swipe.dragging.value).toBe(false);

    swipe.pointerdown(pointer('pointerdown', 20, 20));
    swipe.pointermove(pointer('pointermove', 30, 20));
    expect(swipe.dragging.value).toBe(true);
    swipe.pointercancel(pointer('pointercancel', 30, 20));
    expect(swipe.dragging.value).toBe(false);

    swipe.pointerdown(pointer('pointerdown', 20, 20));
    swipe.pointermove(pointer('pointermove', 30, 20));
    expect(swipe.dragging.value).toBe(true);
    swipe.cancel();
    expect(swipe.dragging.value).toBe(false);
  });

  it('arms at 35 percent, disarms when the finger returns, and respects unavailable sides', () => {
    const { swipe } = setup();
    swipe.pointerdown(pointer('pointerdown', 100, 20));
    swipe.pointermove(pointer('pointermove', 169, 20));
    expect(swipe.armed.value).toBe(false);
    swipe.pointermove(pointer('pointermove', 170, 20));
    expect(swipe.armed.value).toBe(true);
    swipe.pointermove(pointer('pointermove', 150, 20));
    expect(swipe.armed.value).toBe(false);
    swipe.pointerup(pointer('pointerup', 150, 20));
    expect(swipe.armed.value).toBe(false);

    const unavailable = setup(() => false).swipe;
    unavailable.pointerdown(pointer('pointerdown', 100, 20));
    unavailable.pointermove(pointer('pointermove', 180, 20));
    expect(unavailable.armed.value).toBe(false);
  });

  it('cancels a short horizontal movement and suppresses the following click', () => {
    vi.useFakeTimers();
    const { commit, swipe } = setup();
    swipe.pointerdown(pointer('pointerdown', 10, 10));
    swipe.pointermove(pointer('pointermove', 30, 12));
    swipe.pointerup(pointer('pointerup', 30, 12));
    expect(commit).not.toHaveBeenCalled();
    expect(swipe.consumeClick()).toBe(true);
    expect(swipe.consumeClick()).toBe(false);
    vi.runAllTimers();
  });

  it('commits at 35 percent of the row width', () => {
    const { commit, swipe } = setup();
    swipe.pointerdown(pointer('pointerdown', 0, 0));
    swipe.pointermove(pointer('pointermove', -70, 0));
    swipe.pointerup(pointer('pointerup', -70, 0));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('left');
  });

  it('commits a fast flick at 64px', () => {
    vi.useFakeTimers();
    const { commit, swipe } = setup();
    swipe.pointerdown(pointer('pointerdown', 0, 0));
    vi.advanceTimersByTime(20);
    swipe.pointermove(pointer('pointermove', 65, 0));
    swipe.pointerup(pointer('pointerup', 65, 0));
    expect(commit).toHaveBeenCalledWith('right');
  });

  it('resists unavailable sides and never commits them', () => {
    const { commit, swipe } = setup((side) => side === 'left');
    swipe.pointerdown(pointer('pointerdown', 100, 0));
    swipe.pointermove(pointer('pointermove', 170, 0));
    expect(swipe.offset.value).toBe(24);
    swipe.pointerup(pointer('pointerup', 170, 0));
    expect(commit).not.toHaveBeenCalled();
  });

  it('cancels pointercancel and ignores mouse input', () => {
    const { commit, element, swipe } = setup();
    swipe.pointerdown(pointer('pointerdown', 0, 0));
    swipe.pointermove(pointer('pointermove', -90, 0));
    swipe.pointercancel(pointer('pointercancel', -90, 0));
    expect(swipe.offset.value).toBe(0);
    expect(swipe.dragging.value).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(swipe.consumeClick()).toBe(true);
    const mouse = pointer('pointerdown', 0, 0, 1, 'mouse');
    swipe.pointerdown(mouse);
    swipe.pointermove(pointer('pointermove', 100, 0));
    expect(element.setPointerCapture).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });
});
