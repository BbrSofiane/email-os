import { ref } from 'vue';

/** Touch/pen long press for selecting one row; movement and release cancel it. */
export function useLongPressSelection(toggle: () => void, onFire: () => void = () => undefined) {
  const fired = ref(false);
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pointerId = null;
  }

  function pointerdown(event: PointerEvent): void {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    cancel();
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    fired.value = false;
    timer = setTimeout(() => {
      if (pointerId === null) return;
      fired.value = true;
      pointerId = null;
      timer = null;
      onFire();
      toggle();
    }, 500);
  }

  function pointermove(event: PointerEvent): void {
    if (pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
  }

  function pointerup(event: PointerEvent): void {
    if (pointerId === event.pointerId) cancel();
  }

  function consumeClick(): boolean {
    if (!fired.value) return false;
    fired.value = false;
    return true;
  }

  return { fired, pointerdown, pointermove, pointerup, pointercancel: pointerup, cancel, consumeClick };
}
