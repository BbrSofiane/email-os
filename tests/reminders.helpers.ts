import { effectScope } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import RemindersList from '../src/components/RemindersList.vue';
import { useReminders } from '../src/composables/useReminders';
import type { ConversationRef, MailClient } from '../src/lib/ipc/client';

/**
 * Mount the Reminders list the way App does: one `useReminders` model, a live
 * session, an optional picker target. `unmount()` ends the session like leaving
 * the context does.
 */
export function mountReminders(client: MailClient, options: { target?: ConversationRef | null; attachTo?: HTMLElement } = {}) {
  const scope = effectScope();
  const model = scope.run(() => useReminders(client))!;
  if (options.target) model.setTarget(options.target);
  const wrapper: VueWrapper = mount(RemindersList, { props: { model }, attachTo: options.attachTo });
  void model.activate();
  return {
    model,
    wrapper,
    unmount() { wrapper.unmount(); scope.stop(); },
  };
}
