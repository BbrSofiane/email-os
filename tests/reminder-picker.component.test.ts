import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ReminderPicker from '../src/components/ReminderPicker.vue';
import { getReminderPresets } from '../src/lib/reminder-time';
import { getDeviceTimeZone } from '../src/lib/reminder-timezone';

vi.mock('../src/lib/reminder-preferences', () => ({ loadReminderPreferences: () => ({ hour: 9, minute: 0 }) }));
vi.mock('../src/lib/reminder-time', () => ({
  getReminderPresets: vi.fn(() => [
    { id: 'tomorrow', label: 'Tomorrow', dueAt: '2030-01-02T09:00:00Z' },
    { id: 'next-week', label: 'Next Monday', dueAt: '2030-01-08T09:00:00Z' },
    { id: 'weekend', label: 'Next weekend', dueAt: '2030-01-05T09:00:00Z' },
    { id: 'someday', label: 'Someday', dueAt: null },
  ]),
  parseReminderTime: (input: string) => input.includes('T')
    ? { ok: true, dueAt: input, label: 'Custom time' }
    : { ok: false, error: 'Enter a valid future time.' },
}));

function mountPicker(options: Parameters<typeof mount<typeof ReminderPicker>>[1] = {}) {
  return mount(ReminderPicker, { attachTo: document.body, global: { stubs: { Teleport: true } }, ...options });
}

describe('ReminderPicker', () => {
  it('exposes the active option and its resolved time, and Enter matches pointer selection', async () => {
    const wrapper = mountPicker();
    await flushPromises();
    const input = wrapper.get('[role="combobox"]');
    expect(wrapper.text()).toContain(getDeviceTimeZone() ?? 'name unavailable');
    expect(document.activeElement).toBe(input.element);
    expect(input.attributes()).toMatchObject({ 'aria-autocomplete': 'list', 'aria-controls': 'reminder-time-listbox', 'aria-expanded': 'true' });
    await input.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(wrapper.get('[role="combobox"]').attributes('aria-activedescendant')).toBe('reminder-time-option-tomorrow');
    expect(wrapper.get('#reminder-time-option-tomorrow').text()).toContain('January 2, 2030');
    expect(wrapper.get('#reminder-time-option-tomorrow').text()).toContain(getDeviceTimeZone() ?? 'device time zone name unavailable');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')?.[0]).toEqual(['2030-01-02T09:00:00Z']);
    expect(wrapper.get('[aria-live="polite"]').text()).toContain('January 2, 2030');
    expect(wrapper.get('[aria-live="polite"]').text()).toContain(getDeviceTimeZone() ?? 'device time zone name unavailable');
    await wrapper.get('#reminder-time-option-someday').trigger('click');
    expect(wrapper.emitted('select')?.[1]).toEqual([null]);
    expect(wrapper.get('#reminder-time-option-someday').text()).toContain('Untimed');
    expect(wrapper.get('[aria-live="polite"]').text()).toContain('no due time');
    wrapper.unmount();

    const pointer = mountPicker();
    await pointer.get('#reminder-time-option-tomorrow').trigger('click');
    expect(pointer.emitted('select')?.[0]).toEqual(['2030-01-02T09:00:00Z']);
    pointer.unmount();
  });

  it('clears stale active options on filtering and does not allow disabled suggestions to be chosen', async () => {
    const wrapper = mountPicker({ props: { disabled: false } });
    const input = wrapper.get('[role="combobox"]');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(wrapper.get('[role="combobox"]').attributes('aria-activedescendant')).toBe('reminder-time-option-tomorrow');
    await input.setValue('Next Monday');
    await flushPromises();
    expect(wrapper.get('[role="combobox"]').attributes('aria-activedescendant')).toBeUndefined();
    expect(wrapper.find('#reminder-time-option-tomorrow').exists()).toBe(false);
    await wrapper.setProps({ disabled: true });
    expect(wrapper.get('[role="combobox"]').attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[role="combobox"]').attributes('aria-activedescendant')).toBeUndefined();
    await wrapper.get('#reminder-time-option-next-week').trigger('click');
    expect(wrapper.emitted('select')).toBeUndefined();
    expect(wrapper.get('#reminder-time-option-next-week').attributes('aria-disabled')).toBe('true');
    wrapper.unmount();
  });

  it('parses free text and guards IME and modifier Enter', async () => {
    const wrapper = mountPicker();
    const input = wrapper.get('[role="combobox"]');
    await input.setValue('2030-11-03T01:30:00-05:00');
    await input.trigger('keydown', { key: 'Enter', isComposing: true });
    await input.trigger('keydown', { key: 'Enter', ctrlKey: true });
    await input.trigger('keydown', { key: 'Enter', metaKey: true });
    expect(wrapper.emitted('select')).toBeUndefined();
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')?.[0]).toEqual(['2030-11-03T01:30:00-05:00']);
    await flushPromises();
    expect((wrapper.get('[role="combobox"]').element as HTMLInputElement).value).toContain('November 3, 2030');
    expect((wrapper.get('[role="combobox"]').element as HTMLInputElement).value).not.toContain('2030-11-03T01:30:00-05:00');
    expect(wrapper.get('[aria-live="polite"]').text()).toContain('November 3, 2030');
    wrapper.unmount();
  });

  it('shows an existing reschedule in readable form and preserves its exact offset until edited', async () => {
    const original = '2030-11-03T01:30:00-05:00';
    const wrapper = mountPicker({ props: { rescheduling: true, initialValue: original } });
    const input = wrapper.get('[role="combobox"]');
    expect((wrapper.get('[role="combobox"]').element as HTMLInputElement).value).toContain('November 3, 2030');
    expect((input.element as HTMLInputElement).value).not.toContain(original);
    expect(wrapper.find('[role="status"]').text()).not.toContain('No matching suggestions');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')?.[0]).toEqual([original]);
    wrapper.unmount();

    const someday = mountPicker({ props: { rescheduling: true, initialValue: null } });
    expect((someday.get('[role="combobox"]').element as HTMLInputElement).value).toBe('Someday');
    await someday.get('[role="combobox"]').trigger('keydown', { key: 'Enter' });
    expect(someday.emitted('select')?.[0]).toEqual([null]);
    someday.unmount();
  });

  it('lets an active keyboard suggestion replace a saved time and preserves a resolved custom time on repeated Enter', async () => {
    const original = '2030-11-03T01:30:00-05:00';
    const reschedule = mountPicker({ props: { rescheduling: true, initialValue: original } });
    const input = reschedule.get('[role="combobox"]');
    await input.trigger('keydown', { key: 'ArrowDown' });
    await input.trigger('keydown', { key: 'Enter' });
    expect(reschedule.emitted('select')?.[0]).toEqual(['2030-01-02T09:00:00Z']);
    reschedule.unmount();
    const fresh = mountPicker();
    await fresh.get('input').setValue(original);
    await fresh.get('input').trigger('keydown', { key: 'Enter' });
    await fresh.get('input').trigger('keydown', { key: 'Enter' });
    expect(fresh.emitted('select')).toEqual([[original], [original]]);
    fresh.unmount();
  });

  it('marks active edits as unselected until a valid custom time resolves', async () => {
    const wrapper = mountPicker({ props: { rescheduling: true, initialValue: '2030-01-02T09:00:00Z' } });
    const input = wrapper.get('[role="combobox"]');
    await input.setValue('not a time');
    expect(wrapper.emitted('editing')).toHaveLength(1);
    expect(wrapper.get('[role="status"]').text()).toContain('No matching suggestions');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')).toBeUndefined();
    expect(wrapper.get('[role="alert"]').text()).toContain('valid future time');
    await input.setValue('2030-11-03T01:30:00-05:00');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.emitted('select')?.[0]).toEqual(['2030-11-03T01:30:00-05:00']);
    await flushPromises();
    expect((wrapper.get('[role="combobox"]').element as HTMLInputElement).value).toContain('November 3, 2030');
    wrapper.unmount();
  });

  it('announces no matches and invalid custom input, and dismisses with Escape', async () => {
    const wrapper = mountPicker();
    const input = wrapper.get('[role="combobox"]');
    await input.setValue('no preset');
    await flushPromises();
    expect(wrapper.get('[role="combobox"]').attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('[role="combobox"]').attributes('aria-activedescendant')).toBeUndefined();
    expect(wrapper.get('[role="status"]').text()).toContain('No matching suggestions');
    await input.trigger('keydown', { key: 'Enter' });
    expect(wrapper.get('[role="alert"]').text()).toContain('valid future time');
    await input.trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('dismiss')).toHaveLength(1);
    wrapper.unmount();
  });

  it('wraps Tab around summary and controls while preserving native select keys', async () => {
    const wrapper = mountPicker({ slots: { default: '<select><option>If no reply</option><option>Regardless</option></select><button type="button">Save reminder</button>' } });
    const summary = wrapper.get('summary').element as HTMLElement;
    summary.focus();
    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    summary.dispatchEvent(backward);
    expect(document.activeElement).toBe(wrapper.findAll('button').at(-1)!.element);
    const last = wrapper.findAll('button').at(-1)!.element as HTMLElement;
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    last.dispatchEvent(forward);
    expect(document.activeElement).toBe(summary);
    const select = wrapper.get('select').element;
    const arrow = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    select.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(false);
    await wrapper.get('input').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('dismiss')).toHaveLength(1);
    wrapper.unmount();
  });
});


it('skips unavailable presets for keyboard and pointer selection and accepts the default with Enter', async () => {
  vi.mocked(getReminderPresets).mockReturnValueOnce([
    { id: 'unavailable', label: 'Tomorrow (unavailable)', dueAt: null },
    { id: 'someday', label: 'Someday', dueAt: null },
  ]);
  const wrapper = mountPicker();
  await wrapper.get('#reminder-time-option-unavailable').trigger('click');
  expect(wrapper.emitted('select')).toBeUndefined();
  await wrapper.get('input').trigger('keydown', { key: 'ArrowDown' });
  expect(wrapper.get('input').attributes('aria-activedescendant')).toBe('reminder-time-option-someday');
  await wrapper.get('input').trigger('keydown', { key: 'Enter' });
  expect(wrapper.emitted('select')?.[0]).toEqual([null]);
  wrapper.unmount();
  const defaultPicker = mountPicker();
  await defaultPicker.get('input').trigger('keydown', { key: 'Enter' });
  expect(defaultPicker.emitted('select')?.[0]).toEqual(['2030-01-02T09:00:00Z']);
  defaultPicker.unmount();
});
