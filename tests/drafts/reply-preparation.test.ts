import { advanceUiUntil, useUiTestClock } from '../support/timers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import type { DraftReceipt, MailClient } from '../../src/lib/ipc/client';
import { createBrowserFakeMailClient, deferred, fixtureRef, openDraftsList, press } from '../helpers';
import { mountDraftsContextApp } from '../support/drafts';

describe('draft reply preparation', () => {
  let wrapper: VueWrapper | null = null;
  beforeEach(useUiTestClock);
  afterEach(() => { wrapper?.unmount(); wrapper = null; vi.useRealTimers(); });
  it('prepares a reply to the displayed latest message with immutable source and blank body', async () => {
    const fake = createBrowserFakeMailClient();
    const w = wrapper = await mountDraftsContextApp(fake);
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushPromises();
    // Reader actions are teleported into the app header, outside the article.
    const latest = (await fake.getConversation(fixtureRef('conv-01'))).messages.at(-1)!;
    expect(w.find('[data-test="prepare-reply"]').attributes('disabled')).toBeUndefined();
    await w.find('[data-test="prepare-reply"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    // The fixed source is an attribute only: no visible or accessible raw IDs.
    const source = w.find('[data-test="reply-source"]');
    expect(source.attributes('data-source-message')).toBe(latest.id);
    expect(source.attributes('data-source-conversation')).toBe('conv-01');
    expect(source.text()).toBe('');
    expect(w.find('[data-test="composer"]').text()).not.toContain(latest.id);
    // Compact reply: To is a collapsed row until activated; Cc and Subject are on demand.
    expect(w.find('[data-test="draft-to-row"]').text()).toBe('Ada Fixture <ada@example.test>');
    expect(w.find('[data-test="draft-to"]').exists()).toBe(false);
    await w.find('[data-test="draft-to-row"]').trigger('click');
    await flushPromises();
    expect((w.find('[data-test="draft-to"]').element as HTMLInputElement).value).toBe('ada@example.test');
    await w.find('[data-test="draft-fields-toggle"]').trigger('click');
    expect((w.find('[data-test="draft-cc"]').element as HTMLInputElement).value).toBe('');
    expect((w.find('[data-test="draft-subject"]').element as HTMLInputElement).value).toBe('Re: Fixture thread 1: weekly status');
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('');
    const draft = (await fake.listDrafts())[0]!;
    expect(draft.source).toEqual({ kind: 'reply', conversation: fixtureRef('conv-01'), sourceMessageId: latest.id });
  });

  it('cancels an offline reply preparation and immediately permits a new local draft', async () => {
    const fake = createBrowserFakeMailClient();
    let replyAttempts = 0;
    const client: MailClient = {
      ...fake,
      createDraft: (command) => {
        if (command.source.kind === 'reply') {
          replyAttempts += 1;
          return Promise.reject({ kind: 'network_unavailable' });
        }
        return fake.createDraft(command);
      },
    };
    const w = wrapper = await mountDraftsContextApp(fake, client);
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="prepare-reply"]').trigger('click');
    await advanceUiUntil(() => w.find('[data-test="draft-create-error"]').exists());
    expect(w.find('[data-test="cancel-reply-preparation"]').exists()).toBe(true);
    expect(await fake.listDrafts()).toEqual([]);

    await w.find('[data-test="cancel-reply-preparation"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
    // The reply flow keeps the reader open; a new local draft comes from the
    // compose entry (C), which opens the inline compose card.
    press('c', { bubbles: true }, window);
    await flushPromises();
    await advanceUiUntil(() => w.find('[data-test="compose-card"]').exists());
    await advanceUiUntil(() => w.find('[data-test="draft-status"]').text().includes('preview memory'));
    expect(replyAttempts).toBe(1);
    expect((await fake.listDrafts()).map((draft) => draft.source)).toEqual([{ kind: 'new_message' }]);
  });

  it('ignores a late create receipt after clean reply preparation is cancelled but leaves the draft recoverable', async () => {
    const fake = createBrowserFakeMailClient();
    const pendingCreate = deferred<DraftReceipt>();
    let replyCommand: Parameters<MailClient['createDraft']>[0] | null = null;
    const client: MailClient = {
      ...fake,
      createDraft: (command) => {
        if (command.source.kind === 'reply') {
          replyCommand = JSON.parse(JSON.stringify(command)) as Parameters<MailClient['createDraft']>[0];
          return pendingCreate.promise;
        }
        return fake.createDraft(command);
      },
    };
    const w = wrapper = await mountDraftsContextApp(fake, client);
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="prepare-reply"]').trigger('click');
    await advanceUiUntil(() => w.find('[data-test="cancel-reply-preparation"]').exists());
    await w.find('[data-test="cancel-reply-preparation"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(false);

    const receipt = await fake.createDraft(replyCommand!);
    pendingCreate.resolve(receipt);
    await flushPromises();
    // The reply flow keeps the reader open and never auto-opens the drawer; the
    // late receipt must stay recoverable in the drafts list, not in an editor.
    await openDraftsList(w);
    await advanceUiUntil(() => w.text().includes('Re: Fixture thread 1: weekly status'));
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
    expect(await fake.getDraft(receipt.ref)).toMatchObject({ source: { kind: 'reply' } });
  });

  it('allows the broker to prepare a legacy reply with missing cached headers and rejects a stale displayed source', async () => {
    const fake = createBrowserFakeMailClient();
    const client: MailClient = {
      ...fake,
      getConversation: async (ref) => {
        const conversation = await fake.getConversation(ref);
        delete conversation.replyContext;
        return conversation;
      },
    };
    const w = wrapper = await mountDraftsContextApp(fake, client);
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="reply-blocked"]').exists()).toBe(false);
    await w.find('[data-test="prepare-reply"]').trigger('click');
    await flushPromises();
    expect((await fake.listDrafts())[0]?.source).toMatchObject({ kind: 'reply', sourceMessageId: 'conv-01-m3' });

    w.unmount();
    wrapper = null;
    const staleFake = createBrowserFakeMailClient();
    const stale = wrapper = await mountDraftsContextApp(staleFake);
    await stale.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushPromises();
    staleFake.controls.addMessage('conv-01');
    await stale.find('[data-test="prepare-reply"]').trigger('click');
    await flushPromises();
    expect(stale.find('[data-test="draft-create-error"]').text()).toContain('current complete reply headers');
    expect(await staleFake.listDrafts()).toEqual([]);
  });

  it('explains and blocks replies from retained or incomplete cached context', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.markRetainedSnapshot('conv-01', '2025-01-01T00:00:00.000Z');
    const w = wrapper = await mountDraftsContextApp(fake);
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="prepare-reply"]').attributes('disabled')).toBeDefined();
    expect(w.find('[data-test="reply-blocked"]').text()).toContain('retained snapshot');
    expect(await fake.listDrafts()).toEqual([]);

    w.unmount();
    wrapper = null;
    const second = createBrowserFakeMailClient();
    second.controls.markUnsupported('conv-01', 'plain text incomplete', false);
    const w2 = wrapper = await mountDraftsContextApp(second);
    await w2.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushPromises();
    expect(w2.find('[data-test="reply-blocked"]').text()).toContain('incomplete');
    expect(w2.find('[data-test="prepare-reply"]').attributes('disabled')).toBeDefined();
  });

});
