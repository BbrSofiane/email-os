import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SwipeActionSettings from '../src/components/SwipeActionSettings.vue';

describe('SwipeActionSettings', () => {
  beforeEach(() => localStorage.clear());

  it('persists a changed side and emits the preferences used by the list', async () => {
    const wrapper = mount(SwipeActionSettings);
    await wrapper.get('input[name="swipe-left"][value="none"]').setValue();
    expect(JSON.parse(localStorage.getItem('email-os.swipe-preferences.v1')!)).toEqual({ version: 1, right: 'remind', left: 'none' });
    expect(wrapper.emitted('saved')?.[0]?.[0]).toEqual({ right: 'remind', left: 'none' });
    expect(wrapper.get('[role="status"]').text()).toBe('Saved');
  });

  it('reports a storage failure without claiming the new choice was saved', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const wrapper = mount(SwipeActionSettings);
    await wrapper.get('input[name="swipe-left"][value="none"]').setValue();
    expect(wrapper.get('[role="status"]').text()).toBe('Could not save');
    expect(wrapper.emitted('saved')).toBeUndefined();
  });
});
