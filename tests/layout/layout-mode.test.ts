import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLayoutMode } from '../../src/composables/useLayoutMode';

function mountLayoutMode() {
  let mode: ReturnType<typeof useLayoutMode> | undefined;
  const wrapper = mount(defineComponent({
    setup() {
      mode = useLayoutMode();
      return () => h('span', mode!.value);
    },
  }));
  return { wrapper, get mode() { return mode!; } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useLayoutMode', () => {
  it('selects compact below 720px and regular at 720px', () => {
    const listeners = new Map<string, (event: MediaQueryListEvent) => void>();
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: query === '(max-width: 719px)',
      media: query,
      addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener as (event: MediaQueryListEvent) => void),
      removeEventListener: (type: string, listener: EventListener) => {
        if (listeners.get(type) === listener) listeners.delete(type);
      },
    }) as unknown as MediaQueryList);

    const { wrapper, mode } = mountLayoutMode();
    expect(mode.value).toBe('compact');
    wrapper.unmount();
    listeners.clear();

    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as MediaQueryList);
    const regular = mountLayoutMode();
    expect(regular.mode.value).toBe('regular');
    regular.wrapper.unmount();
  });

  it('defaults to regular without matchMedia', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(() => { throw new Error('should not be called'); });
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: undefined });
    const { wrapper, mode } = mountLayoutMode();

    expect(mode.value).toBe('regular');
    wrapper.unmount();
  });

  it('reacts to change events and removes its listener on unmount', async () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    const remove = vi.fn();
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      media: '(max-width: 719px)',
      addEventListener: (_type: string, callback: EventListener) => { listener = callback as (event: MediaQueryListEvent) => void; },
      removeEventListener: remove,
    } as unknown as MediaQueryList);
    const { wrapper, mode } = mountLayoutMode();

    listener?.({ matches: true } as MediaQueryListEvent);
    await nextTick();
    expect(mode.value).toBe('compact');
    wrapper.unmount();
    expect(remove).toHaveBeenCalledOnce();
  });
});
