import { mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import ReminderPicker from '../src/components/ReminderPicker.vue';
import { getReminderPresets, parseReminderTime } from '../src/lib/reminder-time';
import { loadReminderPreferences } from '../src/lib/reminder-preferences';

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });
it('uses the real next week alias before substring suggestions, with explicit suggestion precedence and partial completion', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(2030, 0, 1, 12));
  const preferences = loadReminderPreferences();
  const monday = parseReminderTime('next week', new Date(), preferences);
  expect(monday.ok).toBe(true);
  const weekend = getReminderPresets(new Date(), preferences).find(p => p.label === 'Next weekend')!;
  const picker = mount(ReminderPicker, { attachTo: document.body, global: { stubs: { Teleport: true } } });
  try {
    await picker.get('input').setValue('next week');
    await picker.get('input').trigger('keydown', { key: 'Enter' });
    expect(picker.emitted('select')?.[0]).toEqual([monday.ok ? monday.dueAt : undefined]);
    await picker.get('input').trigger('keydown', { key: 'Enter' });
    expect(picker.emitted('select')?.[1]).toEqual(picker.emitted('select')?.[0]);
    await picker.get('input').setValue('next week');
    await picker.get('input').trigger('keydown', { key: 'ArrowDown' });
    await picker.get('input').trigger('keydown', { key: 'Enter' });
    expect(picker.emitted('select')?.[2]).toEqual([weekend.dueAt]);
    await picker.get('input').setValue('weeke');
    await picker.get('input').trigger('keydown', { key: 'Enter' });
    expect(picker.emitted('select')?.[3]).toEqual([weekend.dueAt]);
    await picker.get('input').setValue('next week');
    await picker.get('[role="option"]').trigger('click');
    expect(picker.emitted('select')?.[4]).toEqual([weekend.dueAt]);
  } finally { picker.unmount(); }
});
