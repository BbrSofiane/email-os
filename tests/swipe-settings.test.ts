import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SwipeActionSettings from '../src/components/SwipeActionSettings.vue';

describe('SwipeActionSettings', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

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

  it('restores the confirmed phone radio after a failed save', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const wrapper = mount(SwipeActionSettings, { props: { compact: true } });
    const current = wrapper.get<HTMLInputElement>('input[name="swipe-left"][value="done"]');
    const tried = wrapper.get<HTMLInputElement>('input[name="swipe-left"][value="none"]');

    await tried.setValue();
    expect(current.element.checked).toBe(true);
    expect(tried.element.checked).toBe(false);
    const [right, left] = wrapper.findAll('[role="status"]');
    expect(right!.text()).toBe('');
    expect(left!.text()).toBe('Could not save swipe left. Still: Mark done.');
    expect(left!.attributes('data-status')).toBe('failed');
    expect(left!.element.previousElementSibling?.textContent).toBe('Swipe left');
    expect(wrapper.emitted('saved')).toBeUndefined();
  });

  it('shows Saved on the edited phone side and clears the other side', async () => {
    const wrapper = mount(SwipeActionSettings, { props: { compact: true } });
    const [right, left] = wrapper.findAll('[role="status"]');
    await wrapper.get('input[name="swipe-right"][value="done"]').setValue();
    expect(right!.text()).toBe('Saved');
    expect(left!.text()).toBe('');

    await wrapper.get('input[name="swipe-left"][value="none"]').setValue();
    expect(right!.text()).toBe('');
    expect(left!.text()).toBe('Saved');
    expect(left!.attributes('data-status')).toBeUndefined();
  });

});
