import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import MobileActionSheet from '../../src/components/mobile/MobileActionSheet.vue';

describe('MobileActionSheet', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders rows, disabled reasons, and emits choose and close', async () => {
    const wrapper = mount(MobileActionSheet, {
      attachTo: document.body,
      props: {
        title: 'Actions',
        items: [
          { id: 'reply', label: 'Reply', glyph: 'reply' },
          { id: 'blocked', label: 'Blocked', glyph: 'done', disabled: true, disabledReason: 'Unavailable' },
        ],
      },
    });
    expect(wrapper.get('[role="dialog"]').attributes('aria-modal')).toBe('true');
    expect(wrapper.text()).toContain('Reply');
    expect(wrapper.get('button:disabled').attributes('aria-label')).toContain('Unavailable');
    await wrapper.get('button:not(:disabled)').trigger('click');
    expect(wrapper.emitted('choose')?.[0]).toEqual(['reply']);
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });

  it('focuses the first row, cycles arrows, and returns focus on close', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const wrapper = mount(MobileActionSheet, {
      attachTo: document.body,
      props: { title: 'Actions', items: [
        { id: 'one', label: 'One', glyph: 'reply' },
        { id: 'two', label: 'Two', glyph: 'done' },
      ] },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const rows = wrapper.findAll('button');
    expect(document.activeElement).toBe(rows[0]!.element);
    await rows[0]!.trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]!.element);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(wrapper.emitted('close')).toHaveLength(1);
    expect(document.activeElement).toBe(opener);
    wrapper.unmount();
  });
});
