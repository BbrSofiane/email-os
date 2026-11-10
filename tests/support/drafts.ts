import { flushPromises } from '@vue/test-utils';
import { advanceUiUntil } from './timers';
import type { VueWrapper } from '@vue/test-utils';
import type { MailClient } from '../../src/lib/ipc/client';
import { mountApp, type BrowserFake } from '../helpers';

export async function mountDraftsApp(fake: BrowserFake, client: MailClient = fake): Promise<VueWrapper> {
  const mounted = mountApp(client, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  await mounted.find('[data-test="rail-drafts"]').trigger('click');
  await advanceUiUntil(() => mounted.find('[data-test="drafts-pane"]').exists());
  await flushPromises();
  return mounted;
}

export async function startNewDraft(w: VueWrapper): Promise<void> {
  await w.find('[data-test="new-draft"]').trigger('click');
  await advanceUiUntil(() => w.find('[data-test="composer"]').exists());
  await advanceUiUntil(() => w.find('[data-test="draft-status"]').text().includes('preview memory'));
}
