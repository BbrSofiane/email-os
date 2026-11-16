import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SelectionBar from '../../src/components/SelectionBar.vue';

const baseProps = {
  count: 3,
  loadedCount: 9,
  context: 'saved' as const,
  actionsEnabled: true,
  readAvailable: true,
};

describe('SelectionBar compact structure', () => {
  it('orders compact controls into the primary and secondary rows', () => {
    const wrapper = mount(SelectionBar, { props: { ...baseProps, compact: true } });
    expect(wrapper.findAll('.selection-row-primary button').map(button => button.attributes('data-test')))
      .toEqual(['selection-clear', 'selection-archive', 'selection-unarchive']);
    expect(wrapper.findAll('.selection-row-secondary button').map(button => button.attributes('data-test')))
      .toEqual(['selection-mark-read', 'selection-mark-unread', 'selection-select-all']);
    expect(wrapper.find('[data-test="selection-limit"]').exists()).toBe(false);
  });

  it('includes selected counts in compact accessible labels', () => {
    const wrapper = mount(SelectionBar, { props: { ...baseProps, compact: true } });
    expect(wrapper.get('[data-test="selection-clear"]').attributes('aria-label')).toBe('Clear selection');
    expect(wrapper.get('[data-test="selection-mark-read"]').attributes('aria-label')).toBe('Mark 3 read');
    expect(wrapper.get('[data-test="selection-mark-unread"]').attributes('aria-label')).toBe('Mark 3 unread');
    expect(wrapper.get('[data-test="selection-select-all"]').attributes('aria-label')).toBe('Select all loaded (9)');
  });

  it('emits every compact event and keeps the limit note below the rows', async () => {
    const wrapper = mount(SelectionBar, {
      props: { ...baseProps, compact: true, limitMessage: 'Selection is limited.' },
    });
    for (const id of ['selection-archive', 'selection-unarchive', 'selection-mark-read', 'selection-mark-unread', 'selection-select-all', 'selection-clear']) {
      await wrapper.get('[data-test="' + id + '"]').trigger('click');
    }
    expect(wrapper.emitted('archive')).toHaveLength(1);
    expect(wrapper.emitted('unarchive')).toHaveLength(1);
    expect(wrapper.emitted('markRead')).toHaveLength(1);
    expect(wrapper.emitted('markUnread')).toHaveLength(1);
    expect(wrapper.emitted('selectAll')).toHaveLength(1);
    expect(wrapper.emitted('clear')).toHaveLength(1);
    expect(wrapper.get('[data-test="selection-limit"]').element.previousElementSibling?.classList.contains('selection-row-secondary')).toBe(true);

    const limited = mount(SelectionBar, {
      props: { ...baseProps, compact: true, loadedCount: 101 },
    });
    expect(limited.get('[data-test="selection-select-all"]').attributes('disabled')).toBeDefined();
    expect(limited.get('[data-test="selection-select-all"]').attributes('title')).toContain('limited to 100');
  });

  it('preserves the regular six text controls and their original order', () => {
    const wrapper = mount(SelectionBar, { props: baseProps });
    expect(wrapper.findAll('.selection-actions button').map(button => button.text()))
      .toEqual([
        'Mark 3 done',
        'Mark 3 not done',
        'Mark 3 read',
        'Mark 3 unread',
        'Select all loaded (9)',
        'Clear selection',
      ]);
    expect(wrapper.find('.selection-row-primary').exists()).toBe(false);
    expect(wrapper.find('.selection-row-secondary').exists()).toBe(false);
  });
});
