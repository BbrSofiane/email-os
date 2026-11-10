import { advanceUiUntil, useUiTestClock } from '../support/timers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { DraftReceipt, MailClient } from '../../src/lib/ipc/client';
import { createBrowserFakeMailClient, deferred } from '../helpers';
import { mountDraftsApp, startNewDraft } from '../support/drafts';

describe('draft close protocol', () => {
  beforeEach(useUiTestClock);
  afterEach(() => vi.useRealTimers());
  it('does not complete native close until the newest edits are saved to the accepted recovery copy', async () => {
    const fake = createBrowserFakeMailClient();
    const source = await fake.createDraft({
      requestId: 'copy-close-latest-seed',
      source: { kind: 'new_message' },
      initialContent: { to: '', cc: '', subject: 'copy snapshot', bodyText: 'before latest edit' },
    });
    const copyAck = deferred<DraftReceipt>();
    const saveAck = deferred<DraftReceipt>();
    const creates: Array<Parameters<MailClient['createDraft']>[0]> = [];
    const saves: Array<Parameters<MailClient['saveDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      createDraft: (command) => { creates.push(command); return copyAck.promise; },
      saveDraft: (command) => {
        saves.push(command);
        return saves.length === 1 ? Promise.reject({ kind: 'not_found' }) : saveAck.promise;
      },
    };
    const w = await mountDraftsApp(fake, client);
    await w.find(`[data-test="open-draft-${source.ref.draftId}"]`).trigger('click');
    await flushPromises();
    await fake.deleteDraft({ ref: source.ref, expectedRevision: source.revision, requestId: 'copy-close-latest-delete' });
    await w.find('[data-test="draft-body"]').setValue('newest exact buffer');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('latest accepted buffer');

    fake.controls.requestAppClose();
    await flushPromises();
    const recovered = await fake.createDraft(creates[0]!);
    copyAck.resolve(recovered);
    await advanceUiUntil(() => saves.length === 2);
    expect(saves[1]?.ref).toEqual(recovered.ref);
    expect(saves[1]?.content.bodyText).toBe('latest accepted buffer');
    expect(fake.controls.completedCloseCount()).toBe(0);

    const saveReceipt = await fake.saveDraft(saves[1]!);
    saveAck.resolve(saveReceipt);
    await advanceUiUntil(() => fake.controls.completedCloseCount() === 1);
    expect(await fake.getDraft(recovered.ref)).toMatchObject({ revision: saveReceipt.revision, content: { bodyText: 'latest accepted buffer' } });
  });

  it('cancels native close on a failed recovery copy and retries the identical request before completing', async () => {
    const fake = createBrowserFakeMailClient();
    const source = await fake.createDraft({
      requestId: 'copy-close-retry-seed',
      source: { kind: 'new_message' },
      initialContent: { to: '', cc: '', subject: 'keep me', bodyText: 'exact text survives' },
    });
    const firstCopy = deferred<DraftReceipt>();
    const secondCopy = deferred<DraftReceipt>();
    const commands: Array<Parameters<MailClient['createDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      createDraft: (command) => {
        commands.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['createDraft']>[0]);
        return commands.length === 1 ? firstCopy.promise : secondCopy.promise;
      },
    };
    const w = await mountDraftsApp(fake, client);
    await w.find(`[data-test="open-draft-${source.ref.draftId}"]`).trigger('click');
    await flushPromises();
    await fake.deleteDraft({ ref: source.ref, expectedRevision: source.revision, requestId: 'copy-close-retry-delete' });
    await w.find('[data-test="discard-draft"]').trigger('click');
    await w.find('[data-test="confirm-discard"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();

    fake.controls.requestAppClose();
    await flushPromises();
    expect(fake.controls.completedCloseCount()).toBe(0);
    firstCopy.reject({ kind: 'storage_unavailable' });
    await advanceUiUntil(() => fake.controls.pendingAppClose() === null);
    expect(fake.controls.completedCloseCount()).toBe(0);
    const unloadWhileCopyRetryRetained = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(unloadWhileCopyRetryRetained);
    expect(unloadWhileCopyRetryRetained.defaultPrevented).toBe(true);
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('exact text survives');

    fake.controls.requestAppClose();
    await flushPromises();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    const recovered = await fake.createDraft(commands[1]!);
    secondCopy.resolve(recovered);
    await advanceUiUntil(() => fake.controls.completedCloseCount() === 1);
    expect(await fake.getDraft(recovered.ref)).toMatchObject({ content: { subject: 'keep me', bodyText: 'exact text survives' } });
    // Browser preview acknowledges the close protocol but does not actually close its window.
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
  });

  it('retries failed close setup on explicit request and retries ambiguous close commands without forgetting their ID', async () => {
    const fake = createBrowserFakeMailClient();
    let subscriptions = 0;
    let saves = 0;
    let cancellations = 0;
    let completions = 0;
    const client: MailClient = {
      ...fake,
      subscribeAppClose: async (listener) => {
        subscriptions += 1;
        if (subscriptions === 1) throw { kind: 'storage_unavailable' };
        return fake.subscribeAppClose(listener);
      },
      saveDraft: (command) => ++saves === 1 ? Promise.reject({ kind: 'storage_unavailable' }) : fake.saveDraft(command),
      cancelAppClose: async (id) => {
        cancellations += 1;
        if (cancellations === 1) throw { kind: 'storage_unavailable' };
        return fake.cancelAppClose(id);
      },
      completeAppClose: async (id) => {
        completions += 1;
        if (completions === 1) throw { kind: 'storage_unavailable' };
        return fake.completeAppClose(id);
      },
    };
    const w = await mountDraftsApp(fake, client);
    await advanceUiUntil(() => w.find('[data-test="draft-close-setup-error"]').exists());
    await w.find('[data-test="retry-close-setup"]').trigger('click');
    await flushPromises();
    expect(subscriptions).toBe(2);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('close retry buffer');
    fake.controls.requestAppClose();
    await flushPromises();
    expect(cancellations).toBe(1);
    expect(w.find('[data-test="retry-close"]').exists()).toBe(true);
    await w.find('[data-test="retry-close"]').trigger('click');
    await flushPromises();
    expect(await fake.getDraft((await fake.listDrafts())[0]!.ref)).toMatchObject({ content: { bodyText: 'close retry buffer' } });
    // First retry completed after cancellation recovery; trigger another request to
    // prove a failed completion retains a retryable pending ID and lock.
    const second = fake.controls.requestAppClose();
    await flushPromises();
    expect(completions).toBe(1);
    expect(w.find('[data-test="retry-close"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).disabled).toBe(true);
    await w.find('[data-test="retry-close"]').trigger('click');
    await flushPromises();
    expect(completions).toBe(2);
    expect(fake.controls.completedCloseCount()).toBe(1);
    expect(second.requestId).toBeTruthy();
  });

  it('flushes a native close request, cancels on failure, and completes only after a later ACK', async () => {
    const fake = createBrowserFakeMailClient();
    const first = deferred<DraftReceipt>();
    let saves = 0;
    const client: MailClient = {
      ...fake,
      saveDraft: (command) => ++saves === 1 ? first.promise : fake.saveDraft(command),
    };
    const w = await mountDraftsApp(fake, client);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('last keystroke');
    const failedClose = fake.controls.requestAppClose();
    await flushPromises();
    expect(saves).toBe(1);
    first.reject({ kind: 'storage_unavailable' });
    await flushPromises();
    await advanceUiUntil(() => fake.controls.pendingAppClose() === null);
    expect(fake.controls.completedCloseCount()).toBe(0);
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('last keystroke');

    const nextClose = fake.controls.requestAppClose();
    expect(nextClose.requestId).not.toBe(failedClose.requestId);
    await flushPromises();
    await advanceUiUntil(() => fake.controls.completedCloseCount() === 1);
    expect(await fake.getDraft((await fake.listDrafts())[0]!.ref)).toMatchObject({ content: { bodyText: 'last keystroke' } });
    expect(fake.controls.pendingAppClose()).toBeNull();
  });

});
