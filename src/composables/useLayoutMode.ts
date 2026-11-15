import { onBeforeUnmount, onMounted, ref } from 'vue';

export type LayoutMode = 'compact' | 'regular';
export function useLayoutMode() {
  const query = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 719px)') : null;
  const mode = ref<LayoutMode>(query?.matches ? 'compact' : 'regular');
  const update = (event: MediaQueryListEvent) => { mode.value = event.matches ? 'compact' : 'regular'; };
  onMounted(() => query?.addEventListener('change', update));
  onBeforeUnmount(() => query?.removeEventListener('change', update));
  return mode;
}
