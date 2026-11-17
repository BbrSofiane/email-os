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

function setup(
  available: (side: 'left' | 'right') => boolean = () => true,
  exitsOnCommit: (side: 'left' | 'right') => boolean = () => false,
  rowWidth = 200,
) {
  const element = document.createElement('div');
  element.setPointerCapture = vi.fn();
  element.getBoundingClientRect = () => ({ width: rowWidth } as DOMRect);
  const commit = vi.fn();
  const swipe = useSwipeAction(() => element, available, commit, exitsOnCommit);
  return { element, commit, swipe };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window, 'matchMedia');
});

const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

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
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout'] });
    const { swipe } = setup();
    swipe.pointerdown(pointer('pointerdown', 100, 20));
    vi.advanceTimersByTime(200);
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

  it.each([
    { name: 'slow 100px drag', distance: 100, elapsed: 250, commits: false },
    { name: 'fast 80px drag', distance: 80, elapsed: 50, commits: true },
    { name: 'slow 40% drag', distance: 160, elapsed: 400, commits: true },
  ])('matches the armed cue to release for a $name', ({ distance, elapsed, commits }) => {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout'] });
    const { commit, swipe } = setup(() => true, undefined, 400);
    swipe.pointerdown(pointer('pointerdown', 0, 0));
    vi.advanceTimersByTime(elapsed);
    swipe.pointermove(pointer('pointermove', distance, 0));
    expect(swipe.armed.value).toBe(commits);
    expect(commit).not.toHaveBeenCalled();

    swipe.pointerup(pointer('pointerup', distance, 0));
    expect(commit).toHaveBeenCalledTimes(commits ? 1 : 0);
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

  it('slides out before committing and resets without animation', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (timer: number) => clearTimeout(timer));
    const { commit, swipe } = setup(() => true, () => true);
    swipe.pointerdown(pointer('pointerdown', 100, 10));
    swipe.pointermove(pointer('pointermove', 30, 10));
    swipe.pointerup(pointer('pointerup', 30, 10));
    expect(commit).not.toHaveBeenCalled();
    expect(swipe.offset.value).toBe(-200);
    expect(swipe.leaving.value).toBe('left');
    vi.advanceTimersByTime(159);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('left');
    vi.advanceTimersByTime(40);
    expect(swipe.offset.value).toBe(0);
    expect(swipe.leaving.value).toBe(null);
    expect(swipe.resetting.value).toBe(false);
  });

  it('cancels a queued exit commit', () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
    vi.stubGlobal('cancelAnimationFrame', (timer: number) => clearTimeout(timer));
    const { commit, swipe } = setup(() => true, () => true);
    swipe.pointerdown(pointer('pointerdown', 100, 10));
    swipe.pointermove(pointer('pointermove', 30, 10));
    swipe.pointerup(pointer('pointerup', 30, 10));
    swipe.cancel();
    vi.advanceTimersByTime(200);
    expect(commit).not.toHaveBeenCalled();
    expect(swipe.offset.value).toBe(0);
  });

  it('commits immediately for non-exit and reduced-motion actions', () => {
    const immediate = setup(() => true);
    immediate.swipe.pointerdown(pointer('pointerdown', 100, 10));
    immediate.swipe.pointermove(pointer('pointermove', 30, 10));
    immediate.swipe.pointerup(pointer('pointerup', 30, 10));
    expect(immediate.commit).toHaveBeenCalledTimes(1);

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    const reduced = setup(() => true, () => true);
    reduced.swipe.pointerdown(pointer('pointerdown', 100, 10));
    reduced.swipe.pointermove(pointer('pointermove', 30, 10));
    reduced.swipe.pointerup(pointer('pointerup', 30, 10));
    expect(reduced.commit).toHaveBeenCalledTimes(1);
    expect(reduced.swipe.offset.value).toBe(0);
  });
});
