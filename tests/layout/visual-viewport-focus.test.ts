import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useVisualViewportFocus } from '../../src/composables/useVisualViewportFocus';

describe('useVisualViewportFocus', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, 'visualViewport');
  });

  it('reveals the focused editor field on visual viewport resize and scroll', async () => {
    const viewport = new EventTarget();
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    const Harness = defineComponent({
      setup() {
        const root = ref<HTMLElement | null>(null);
        useVisualViewportFocus(root);
        return () => h('div', { ref: root }, [h('input', { 'data-test': 'field' })]);
      },
    });
    const wrapper = mount(Harness, { attachTo: document.body });
    const field = wrapper.get('input').element;
    const reveal = vi.fn();
    field.scrollIntoView = reveal;
    field.focus();
    viewport.dispatchEvent(new Event('resize'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(reveal).toHaveBeenCalledWith({ block: 'nearest' });
    reveal.mockClear();
    viewport.dispatchEvent(new Event('scroll'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(reveal).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
