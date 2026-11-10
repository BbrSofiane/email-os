import { advanceUiUntil, useUiTestClock } from '../support/timers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { MailClient } from '../../src/lib/ipc/client';
import { closeUtilityDrawer, createBrowserFakeMailClient, deferred, openUtilityDrawer } from '../helpers';
import { mountDraftsApp, startNewDraft } from '../support/drafts';

describe('draft account transitions', () => {
  beforeEach(useUiTestClock);
  afterEach(() => vi.useRealTimers());
  it('blocks editor entry for the full account disconnect transition', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'read_only' });
    const disconnect = deferred<void>();
    const client: MailClient = {
      ...fake,
      disconnectAccount: async () => { await disconnect.promise; await fake.disconnectAccount(); },
    };
    const w = await mountDraftsApp(fake, client);
    await openUtilityDrawer(w, 'account');
    await w.find('[data-test="account-disconnect"]').trigger('click');
    await flushPromises();
    await openUtilityDrawer(w, 'drafts');
    expect(w.find('[data-test="new-draft"]').attributes('disabled')).toBeDefined();
    await w.find('[data-test="new-draft"]').trigger('click');
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
    disconnect.resolve();
    await flushPromises();
    await openUtilityDrawer(w, 'account');
    await advanceUiUntil(() => w.find('[data-test="account-connect"]').exists());
    expect(await fake.listDrafts()).toEqual([]);
  });

  it('clears prior-account summaries before a delayed new-account list completes', async () => {
    const fake = createBrowserFakeMailClient();
    const initial = await fake.createDraft({ requestId: 'account-summary-a', source: { kind: 'new_message' }, initialContent: { to: '', cc: '', subject: 'account A private subject', bodyText: '' } });
    const otherAccountList = deferred<Awaited<ReturnType<MailClient['listDrafts']>>>();
    const client: MailClient = {
      ...fake,
      listDrafts: () => fake.controls.accountState().emailAddress === 'other@example.test' ? otherAccountList.promise : fake.listDrafts(),
    };
    const w = await mountDraftsApp(fake, client);
    await advanceUiUntil(() => w.text().includes('account A private subject'));
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'other@example.test', mutationAccess: 'read_only' });
    await advanceUiUntil(() => w.find('[data-test="rail-account"]').exists());
    await openUtilityDrawer(w, 'account');
    await advanceUiUntil(() => w.find('[data-test="account-email"]').exists() && w.find('[data-test="account-email"]').text() === 'other@example.test');
    await flushPromises();
    expect(w.text()).not.toContain('account A private subject');
    otherAccountList.resolve([]);
    await flushPromises();
    expect(w.text()).not.toContain('account A private subject');
    expect(initial.ref.accountId).toBe('fixture-account');
  });

  it('prevents disconnect on an unacknowledged edit and recovers local drafts after reconnecting the same account', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'read_only' });
    let saves = 0;
    let disconnects = 0;
    const client: MailClient = {
      ...fake,
      saveDraft: (command) => ++saves === 1 ? Promise.reject({ kind: 'storage_unavailable' }) : fake.saveDraft(command),
      disconnectAccount: async () => { disconnects += 1; await fake.disconnectAccount(); },
    };
    const w = await mountDraftsApp(fake, client);
    await openUtilityDrawer(w, 'account');
    expect(w.find('[data-test="disconnect-warning"]').text()).toContain('local drafts remain on this device');
    await closeUtilityDrawer(w);
    await openUtilityDrawer(w, 'drafts');
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('must persist through disconnect');
    // The blocked switch keeps the editor visible with its exact buffer; the
    // user remains on the drafts drawer and cannot reach disconnect controls.
    await openUtilityDrawer(w, 'account');
    await flushPromises();
    expect(w.find('[data-test="draft-body"]').exists()).toBe(true);
    expect(w.find('[data-test="account-disconnect"]').exists()).toBe(false);
    expect(disconnects).toBe(0);
    expect(fake.controls.accountState().connection).toBe('connected');
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('must persist through disconnect');

    await w.find('[data-test="retry-draft-save"]').trigger('click');
    await flushPromises();
    await openUtilityDrawer(w, 'account');
    await w.find('[data-test="account-disconnect"]').trigger('click');
    await flushPromises();
    expect(disconnects).toBe(1);
    await advanceUiUntil(() => w.find('[data-test="account-connect"]').exists());
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(false);
    await w.find('[data-test="account-connect"]').trigger('click');
    await flushPromises();
    await openUtilityDrawer(w, 'drafts');
    await advanceUiUntil(() => w.find('[data-test^="open-draft-"]').exists());
    await w.find('[data-test^="open-draft-"]').trigger('click');
    await flushPromises();
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('must persist through disconnect');
  });

  it('ignores a late draft load after the active account changes', async () => {
    const fake = createBrowserFakeMailClient();
    const receipt = await fake.createDraft({ requestId: 'seed-late-load', source: { kind: 'new_message' }, initialContent: { to: '', cc: '', subject: 'old account secret', bodyText: 'old account body' } });
    const loadedDraft = await fake.getDraft(receipt.ref);
    const pending = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
    let reads = 0;
    const client: MailClient = {
      ...fake,
      getDraft: (ref) => {
        reads += 1;
        return reads === 1 ? pending.promise : fake.getDraft(ref);
      },
    };
    const w = await mountDraftsApp(fake, client);
    await w.find(`[data-test="open-draft-${receipt.ref.draftId}"]`).trigger('click');
    await flushPromises();
    expect(reads).toBe(1);
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'other@example.test', mutationAccess: 'read_only' });
    await flushPromises();
    pending.resolve(loadedDraft);
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
    expect(w.text()).not.toContain('old account secret');
    expect(w.text()).not.toContain('old account body');
  });

  it('hides another account’s drafts without replacing a suspended dirty buffer, and edits drafts in read-only Gmail mode', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountDraftsApp(fake);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('account one unacked');
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'read_only' });
    await flushPromises();
    await advanceUiUntil(() => w.find('[data-test="composer"]').exists() === false);
    expect(w.text()).not.toContain('account one unacked');
    expect(w.find('[data-test="suspended-editor"]').text()).toContain('suspended in memory');
    expect(w.text()).toContain('No local drafts.');

    fake.controls.setAccount({ mode: 'fixture', connection: 'connected', emailAddress: 'you@fixture.emailos' });
    await flushPromises();
    await advanceUiUntil(() => w.find('[data-test="composer"]').exists());
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('account one unacked');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();

    w.unmount();
    const gmailFake = createBrowserFakeMailClient();
    gmailFake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'read_only' });
    const gmail = await mountDraftsApp(gmailFake);
    await gmail.find('[data-test="new-draft"]').trigger('click');
    await flushPromises();
    expect(gmail.find('[data-test="composer"]').exists()).toBe(true);
    await gmail.find('[data-test="draft-subject"]').setValue('read-only Gmail is still draft-capable');
    await gmail.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect((await gmailFake.listDrafts()).map((draft) => draft.ref.accountId)).toEqual(['gmail-account']);
  });
});
