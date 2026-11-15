import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import MobileTopBar from '../../src/components/mobile/MobileTopBar.vue';
import MobileBottomBar from '../../src/components/mobile/MobileBottomBar.vue';
import type { ActionId } from '../../src/lib/action-registry';

const available = (id: ActionId) => id !== 'account';
const label = (id: ActionId) => `Run ${id}`;

describe('MobileTopBar', () => {
  it('names the controls, dispatches actions, and exposes the reader back host', async () => {
    const executeAction = vi.fn();
    const openDestinations = vi.fn();
    const wrapper = mount(MobileTopBar, {
      props: { reader: false, title: 'Inbox', executeAction, openDestinations },
    });

    expect(wrapper.get('[data-test="mobile-menu"]').attributes('aria-label')).toBeTruthy();
    expect(wrapper.get('[data-test="mobile-compose"]').attributes('title')).toContain('Compose');
    await wrapper.get('[data-test="mobile-menu"]').trigger('click');
    await wrapper.get('[data-test="mobile-compose"]').trigger('click');
    expect(openDestinations).toHaveBeenCalledOnce();
    expect(executeAction).toHaveBeenCalledWith('compose');

    await wrapper.setProps({ reader: true });
    expect(wrapper.find('[data-test="mobile-menu"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="mobile-compose"]').exists()).toBe(false);
    expect(wrapper.vm.backHost).toBeTruthy();
  });
});

describe('MobileBottomBar', () => {
  it('dispatches navigation, marks Mail current, disables unavailable actions, and exposes hosts', async () => {
    const executeAction = vi.fn();
    const wrapper = mount(MobileBottomBar, {
      props: {
        reader: false,
        inboxOrSaved: true,
        executeAction,
        actionAvailable: available,
        actionLabel: label,
      },
    });

    expect(wrapper.get('nav').attributes('aria-label')).toBe('Primary');
    expect(wrapper.get('[data-test="mobile-mail"]').attributes('aria-current')).toBe('page');
    expect(wrapper.get('[data-test="mobile-account"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-test="mobile-account"]').attributes('title')).toBe('Run account');
    await wrapper.get('[data-test="mobile-mail"]').trigger('click');
    await wrapper.get('[data-test="mobile-search"]').trigger('click');
    expect(executeAction).toHaveBeenNthCalledWith(1, 'inbox');
    expect(executeAction).toHaveBeenNthCalledWith(2, 'search');
    expect(wrapper.vm.actionsHost).toBeTruthy();
    expect(wrapper.vm.contextHost).toBeTruthy();
    // Always rendered as an empty Teleport target; CSS hides it while empty.
    expect(wrapper.get('[data-test="mobile-context-slot"]').element.childNodes).toHaveLength(0);
  });

  it('shows the reader action host without navigation', () => {
    const wrapper = mount(MobileBottomBar, {
      props: {
        reader: true,
        inboxOrSaved: false,
        executeAction: vi.fn(),
        actionAvailable: available,
        actionLabel: label,
      },
    });

    expect(wrapper.find('[data-test="mobile-reader-actions"]').exists()).toBe(true);
    expect(wrapper.html()).not.toContain('<nav');
    expect(wrapper.html()).not.toContain('mobile-account');
  });
});
