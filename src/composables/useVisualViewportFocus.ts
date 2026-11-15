import { onBeforeUnmount, onMounted, type Ref } from 'vue';

/** Keep the focused editor control in the visible area after the phone keyboard resizes the viewport. */
export function useVisualViewportFocus(root: Ref<HTMLElement | null>): void {
  let frame = 0;
  const reveal = (): void => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !root.value?.contains(active)) return;
      active.scrollIntoView?.({ block: 'nearest' });
    });
  };
  const viewport = (): VisualViewport | null => window.visualViewport ?? null;
  onMounted(() => {
    document.addEventListener('focusin', reveal);
    viewport()?.addEventListener('resize', reveal);
    viewport()?.addEventListener('scroll', reveal);
  });
  onBeforeUnmount(() => {
    document.removeEventListener('focusin', reveal);
    viewport()?.removeEventListener('resize', reveal);
    viewport()?.removeEventListener('scroll', reveal);
    if (frame) cancelAnimationFrame(frame);
  });
}
