import { ref } from 'vue';

export type SwipeSide = 'left' | 'right' | null;

/** Pointer-only row gesture state; action availability is supplied by the caller. */
export function useSwipeAction(
  element: () => HTMLElement | null,
  canReveal: (side: Exclude<SwipeSide, null>) => boolean,
  commit: (side: Exclude<SwipeSide, null>) => void,
) {
  const offset = ref(0);
  const revealed = ref<SwipeSide>(null);
  const suppressClick = ref(false);
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startedAt = 0;
  let decided = false;
  let horizontal = false;

  function pointerdown(event: PointerEvent): void {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startedAt = performance.now();
    decided = horizontal = false;
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
      element()?.setPointerCapture(event.pointerId);
    }
    if (!horizontal) return;
    const side = dx >= 0 ? 'right' : 'left';
    offset.value = canReveal(side) ? dx : Math.sign(dx) * Math.min(24, Math.abs(dx));
    revealed.value = offset.value === 0 ? null : side;
  }

  function finish(event: PointerEvent, cancelled = false): void {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    if (cancelled || !horizontal) {
      offset.value = 0;
      revealed.value = null;
      return;
    }
    const dx = event.clientX - startX;
    const side = dx >= 0 ? 'right' : 'left';
    const elapsed = Math.max(1, performance.now() - startedAt);
    const velocity = Math.abs(dx) / elapsed;
    const width = element()?.getBoundingClientRect().width ?? 0;
    const shouldCommit = canReveal(side) && (Math.abs(dx) >= width * 0.35 || (Math.abs(dx) >= 64 && velocity > 0.5));
    suppressClick.value = true;
    setTimeout(() => { suppressClick.value = false; }, 0);
    if (shouldCommit) commit(side);
    offset.value = 0;
    revealed.value = null;
  }

  return {
    offset,
    revealed,
    pointerdown,
    pointermove,
    pointerup: (event: PointerEvent) => finish(event),
    pointercancel: (event: PointerEvent) => finish(event, true),
    consumeClick: () => {
      if (!suppressClick.value) return false;
      suppressClick.value = false;
      return true;
    },
  };
}
