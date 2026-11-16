import { ref } from 'vue';

export type SwipeSide = 'left' | 'right' | null;

/** Pointer-only row gesture state; action availability is supplied by the caller. */
export function useSwipeAction(
  element: () => HTMLElement | null,
  canReveal: (side: Exclude<SwipeSide, null>) => boolean,
  commit: (side: Exclude<SwipeSide, null>) => void,
  exitsOnCommit: (side: Exclude<SwipeSide, null>) => boolean = () => false,
) {
  const offset = ref(0);
  const revealed = ref<SwipeSide>(null);
  const dragging = ref(false);
  const armed = ref(false);
  const leaving = ref<SwipeSide>(null);
  const resetting = ref(false);
  const suppressClick = ref(false);
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let resetFrame: number | null = null;
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startedAt = 0;
  let rowWidth = 0;
  let decided = false;
  let horizontal = false;

  function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function clearCommitTimer(): void {
    if (commitTimer !== null) clearTimeout(commitTimer);
    commitTimer = null;
  }

  function clearResetFrame(): void {
    if (resetFrame !== null) cancelAnimationFrame(resetFrame);
    resetFrame = null;
  }

  function queueExitReset(): void {
    resetFrame = requestAnimationFrame(() => {
      offset.value = 0;
      leaving.value = null;
      resetFrame = requestAnimationFrame(() => {
        resetting.value = false;
        resetFrame = null;
      });
    });
  }

  function pointerdown(event: PointerEvent): void {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startedAt = performance.now();
    decided = horizontal = false;
    dragging.value = false;
  }

  function pointermove(event: PointerEvent): void {
    if (pointerId !== event.pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (!decided && Math.max(Math.abs(dx), Math.abs(dy)) >= 10) {
      decided = true;
      if (Math.abs(dy) > Math.abs(dx)) {
        pointerId = null;
        offset.value = 0;
        revealed.value = null;
        return;
      }
      horizontal = true;
      dragging.value = true;
      rowWidth = element()?.getBoundingClientRect().width ?? 0;
      element()?.setPointerCapture?.(event.pointerId);
    }
    if (!horizontal) return;
    const side = dx >= 0 ? 'right' : 'left';
    offset.value = canReveal(side) ? dx : Math.sign(dx) * Math.min(24, Math.abs(dx));
    revealed.value = offset.value === 0 ? null : side;
    armed.value = canReveal(side) && Math.abs(dx) >= rowWidth * 0.35;
  }

  function finish(event: PointerEvent, cancelled = false): void {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    if (cancelled || !horizontal) {
      if (horizontal) {
        suppressClick.value = true;
        setTimeout(() => { suppressClick.value = false; }, 0);
      }
      dragging.value = false;
      armed.value = false;
      offset.value = 0;
      revealed.value = null;
      return;
    }
    const dx = event.clientX - startX;
    const side = dx >= 0 ? 'right' : 'left';
    const elapsed = Math.max(1, performance.now() - startedAt);
    const velocity = Math.abs(dx) / elapsed;
    const shouldCommit = canReveal(side) && (Math.abs(dx) >= rowWidth * 0.35 || (Math.abs(dx) >= 64 && velocity > 0.5));
    suppressClick.value = true;
    setTimeout(() => { suppressClick.value = false; }, 0);
    dragging.value = false;
    armed.value = false;
    if (shouldCommit && exitsOnCommit(side) && !prefersReducedMotion()) {
      leaving.value = side;
      offset.value = side === 'left' ? -rowWidth : rowWidth;
      clearCommitTimer();
      commitTimer = setTimeout(() => {
        commitTimer = null;
        commit(side);
        resetting.value = true;
        queueExitReset();
      }, 160);
    } else {
      if (shouldCommit) commit(side);
      offset.value = 0;
      revealed.value = null;
      leaving.value = null;
    }
  }

  function cancel(): void {
    clearCommitTimer();
    clearResetFrame();
    pointerId = null;
    horizontal = false;
    dragging.value = false;
    armed.value = false;
    resetting.value = false;
    offset.value = 0;
    revealed.value = null;
    leaving.value = null;
  }

  return {
    offset,
    revealed,
    dragging,
    armed,
    leaving,
    resetting,
    pointerdown,
    pointermove,
    pointerup: (event: PointerEvent) => finish(event),
    pointercancel: (event: PointerEvent) => finish(event, true),
    cancel,
    consumeClick: () => {
      if (!suppressClick.value) return false;
      suppressClick.value = false;
      return true;
    },
  };
}
