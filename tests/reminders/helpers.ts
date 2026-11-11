import { effectScope } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import RemindersList from '../../src/components/RemindersList.vue';
import { useReminders, type ReminderDestination } from '../../src/composables/useReminders';
import type { ConversationRef, MailClient, Reminder } from '../../src/lib/ipc/client';

/**
 * Mount the Reminders list the way App does: one `useReminders` model, a live
 * session, an optional picker target. `unmount()` ends the session like leaving
 * the context does.
 */
export function mountReminders(client: MailClient, options: { target?: ConversationRef | null; attachTo?: HTMLElement; initialDestination?: ReminderDestination } = {}) {
  const scope = effectScope();
  /** What App gets through the model's hooks: acknowledged puts and dismissed new pickers. */
  const scheduled: Array<[Reminder, boolean]> = [];
  const dismissed: number[] = [];
  const model = scope.run(() => useReminders(client, {
    initialDestination: options.initialDestination,
    onScheduled: (receipt, rescheduled) => { scheduled.push([receipt, rescheduled]); },
    onDismissed: () => { dismissed.push(1); },
  }))!;
  if (options.target) model.setTarget(options.target);
  const wrapper: VueWrapper = mount(RemindersList, { props: { model }, global: { stubs: { Teleport: true } }, attachTo: options.attachTo });
  void model.activate();
  return {
    model,
    wrapper,
    scheduled,
    dismissed,
    unmount() { wrapper.unmount(); scope.stop(); },
  };
}

/** Type a time into the shared picker's field and press Enter, like a keyboard user (the picker resolves it). */
export async function pickTime(root: Pick<VueWrapper, 'get'>, text = '2035-11-03T01:30:00-05:00'): Promise<void> {
  const input = root.get('#reminder-time-input');
  await input.setValue(text);
  await input.trigger('keydown', { key: 'Enter' });
  await flushPromises();
}

/** Press the picker's primary button (`Schedule reminder` or `Save new time`). */
export async function submitPicker(root: Pick<VueWrapper, 'findAll'>): Promise<void> {
  const button = root.findAll('button').find((candidate) => ['Schedule reminder', 'Save new time'].includes(candidate.text()));
  if (!button) throw new Error('No Schedule reminder or Save new time button');
  await button.trigger('click');
  await flushPromises();
}
