import { advanceUiUntil, useUiTestClock } from './support/timers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import DraftsPanel from '../src/components/DraftsPanel.vue';
import type { DraftReceipt, DraftRef, MailClient } from '../src/lib/ipc/client';
import { createBrowserFakeMailClient, deferred, openUtilityDrawer, createKeyEvent } from './helpers';
import { mountDraftsApp as mountDraftsUi, startNewDraft } from './support/drafts';

describe('draft save and receipt integrity', () => {
  let wrapper: VueWrapper | null = null;

  beforeEach(useUiTestClock);

  /**
   * The drawer is one column: while an editor is open, the list (with New draft
   * and the draft rows) is not on screen, so the UI no longer offers a switch.
   * These tests guard the lifecycle behind it, so the request is sent through
   * the panel's own events, which reach the same App handlers the buttons used.
   */
  async function requestEditorSwitch(w: VueWrapper, to?: DraftRef): Promise<void> {
    const panel = w.findComponent(DraftsPanel);
    if (to) panel.vm.$emit('openDraft', to);
    else panel.vm.$emit('newDraft');
    await flushPromises();
  }

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
  });

  it('creates, autosaves, closes, and reopens exact raw text in all four fields', async () => {
    const fake = createBrowserFakeMailClient();
    const w = wrapper = await mountDraftsUi(fake);
    await startNewDraft(w);
    await w.find('[data-test="draft-to"]').setValue('  not an address, left as typed  ');
    // Cc is on demand in the new-message layout.
    expect(w.find('[data-test="draft-cc"]').exists()).toBe(false);
    await w.find('[data-test="draft-fields-toggle"]').trigger('click');
    await w.find('[data-test="draft-cc"]').setValue('cc raw; no validation');
    await w.find('[data-test="draft-subject"]').setValue('<literal subject>');
    await w.find('[data-test="draft-body"]').setValue('Unicode ✓\n<script>still text</script>\nlast line');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
    expect(w.findAll('[data-test^="open-draft-"]')).toHaveLength(1);

    const summary = (await fake.listDrafts())[0]!;
    await w.find(`[data-test="open-draft-${summary.ref.draftId}"]`).trigger('click');
    await flushPromises();
    expect((w.find('[data-test="draft-to"]').element as HTMLInputElement).value).toBe('  not an address, left as typed  ');
    expect((w.find('[data-test="draft-cc"]').element as HTMLInputElement).value).toBe('cc raw; no validation');
    expect((w.find('[data-test="draft-subject"]').element as HTMLInputElement).value).toBe('<literal subject>');
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('Unicode ✓\n<script>still text</script>\nlast line');
    expect(w.find('[data-test="draft-body"]').element.querySelector('script')).toBeNull();
    // The local-only detail is the body's hidden description, not a visible paragraph.
    expect(w.find('[data-test="draft-local-detail"]').text()).toContain('stored as typed and are not validated');
    expect(w.find('[data-test="draft-local-detail"]').classes()).toContain('visually-hidden');
    expect(w.find('[data-test="draft-body"]').attributes('aria-describedby')).toBe(w.find('[data-test="draft-local-detail"]').attributes('id'));
    expect(w.text()).toContain('Loaded from preview memory (non-durable)');
    expect(w.find('button').text()).not.toMatch(/send/i);
  });

  it('debounces ordinary edits into an acknowledged local revision', async () => {
    const fake = createBrowserFakeMailClient();
    const w = wrapper = await mountDraftsUi(fake);
    await startNewDraft(w);
    const ref = (await fake.listDrafts())[0]!.ref;
    await w.find('[data-test="draft-body"]').setValue('debounced value ✓');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    expect(await fake.getDraft(ref)).toMatchObject({ revision: 2, content: { bodyText: 'debounced value ✓' } });
    expect(w.find('[data-test="draft-status"]').text()).toContain('Saved in preview memory (non-durable)');
  });

  it('an older save ACK never labels newer text as saved', async () => {
    const fake = createBrowserFakeMailClient();
    const first = deferred<DraftReceipt>();
    const second = deferred<DraftReceipt>();
    const commands: Array<Parameters<MailClient['saveDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      saveDraft: (command) => {
        commands.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['saveDraft']>[0]);
        if (commands.length === 1) return first.promise;
        if (commands.length === 2) return second.promise;
        return fake.saveDraft(command);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('frozen snapshot');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('newer live buffer');
    const firstReceipt = await fake.saveDraft(commands[0]!);
    first.resolve(firstReceipt);
    await flushPromises();
    expect(commands).toHaveLength(2);
    expect(commands[0]?.content.bodyText).toBe('frozen snapshot');
    expect(commands[1]?.content.bodyText).toBe('newer live buffer');
    expect(w.find('[data-test="draft-status"]').text()).toContain('Saving locally');
    expect(w.find('[data-test="draft-status"]').text()).not.toContain('Saved in preview memory');
    second.resolve(await fake.saveDraft(commands[1]!));
    await flushPromises();
    expect(await fake.getDraft(commands[0]!.ref)).toMatchObject({ revision: 3, content: { bodyText: 'newer live buffer' } });
  });

  it('refetches draft summaries on focus and reconnect without replacing the editor buffer', async () => {
    const fake = createBrowserFakeMailClient();
    let lists = 0;
    const client: MailClient = { ...fake, listDrafts: async () => { lists += 1; return fake.listDrafts(); } };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('buffer survives focus');
    const baseline = lists;
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    await flushPromises();
    expect(lists).toBeGreaterThanOrEqual(baseline + 2);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('buffer survives focus');
  });

  it('keeps subscription failure visible across successful list reads and refreshes own save summaries', async () => {
    const fake = createBrowserFakeMailClient();
    let subscriptionAttempts = 0;
    const saves: Array<Parameters<MailClient['saveDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      subscribeDrafts: async (listener) => {
        subscriptionAttempts += 1;
        if (subscriptionAttempts < 3) throw { kind: 'storage_unavailable' };
        return fake.subscribeDrafts(listener);
      },
      saveDraft: (command) => { saves.push(command); return fake.saveDraft(command); },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await advanceUiUntil(() => w.find('[data-test="draft-subscription-error"]').exists());
    expect(w.find('[data-test="draft-list-error"]').exists()).toBe(false);
    expect(subscriptionAttempts).toBe(1);

    await startNewDraft(w);
    await w.find('[data-test="draft-subject"]').setValue('saved without draft event listener');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await advanceUiUntil(() => w.text().includes('saved without draft event listener'));
    expect(w.find('[data-test="draft-subscription-error"]').exists()).toBe(true);

    const draft = (await fake.listDrafts())[0]!;
    await w.find(`[data-test="open-draft-${draft.ref.draftId}"]`).trigger('click');
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('dirty buffer survives failed-listener refresh');
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(subscriptionAttempts).toBe(2);
    expect(w.find('[data-test="draft-subscription-error"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-list-error"]').exists()).toBe(false);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('dirty buffer survives failed-listener refresh');

    await w.find('[data-test="retry-draft-subscription"]').trigger('click');
    await flushPromises();
    expect(subscriptionAttempts).toBe(3);
    expect(w.find('[data-test="draft-subscription-error"]').exists()).toBe(false);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('dirty buffer survives failed-listener refresh');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(saves).toHaveLength(2);
    expect(saves[0]?.expectedRevision).toBe(1);
    expect(saves[1]?.expectedRevision).toBe(2);
  });

  it('background draft hints do not overwrite a dirty editor or advance its CAS revision', async () => {
    const fake = createBrowserFakeMailClient();
    const w = wrapper = await mountDraftsUi(fake);
    await startNewDraft(w);
    const original = (await fake.listDrafts())[0]!;
    const before = await fake.getDraft(original.ref);
    await fake.saveDraft({
      ref: original.ref,
      expectedRevision: before.revision,
      requestId: 'external-summary-save',
      content: { ...before.content, subject: 'external subject' },
    });
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('my exact unsaved body');
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('my exact unsaved body');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-conflict-actions"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('my exact unsaved body');

    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    const drafts = await fake.listDrafts();
    expect(drafts).toHaveLength(2);
    expect((await fake.getDraft(drafts.find((item) => item.ref.draftId !== original.ref.draftId)!.ref)).source).toEqual({ kind: 'new_message' });
    expect((await fake.getDraft(drafts.find((item) => item.ref.draftId !== original.ref.draftId)!.ref)).content.bodyText).toBe('my exact unsaved body');
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-conflict-actions"]').exists()).toBe(false);
  });

  it('retries a lost save using the original frozen request before coalesced newer edits', async () => {
    const fake = createBrowserFakeMailClient();
    const first = deferred<DraftReceipt>();
    const commands: Array<Parameters<MailClient['saveDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      saveDraft: (command) => {
        commands.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['saveDraft']>[0]);
        return commands.length === 1 ? first.promise : fake.saveDraft(command);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('frozen text');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(commands).toHaveLength(1);
    await w.find('[data-test="draft-body"]').setValue('newer text while save is in flight');
    first.reject({ kind: 'storage_unavailable' });
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('newer text while save is in flight');
    await w.find('[data-test="retry-draft-save"]').trigger('click');
    await flushPromises();
    expect(commands.length).toBeGreaterThanOrEqual(3);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[2]?.content.bodyText).toBe('newer text while save is in flight');
    expect(commands[2]?.expectedRevision).toBe(2);
    expect((await fake.getDraft(commands[0]!.ref)).content.bodyText).toBe('newer text while save is in flight');
  });

  it('fixes a validate-only failure with a new request instead of replaying invalid text', async () => {
    const fake = createBrowserFakeMailClient();
    const commands: Array<Parameters<MailClient['saveDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      saveDraft: (command) => {
        commands.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['saveDraft']>[0]);
        return commands.length === 1 ? Promise.reject({ kind: 'invalid_request', field: 'bodyText' }) : fake.saveDraft(command);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('too long');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="draft-error"]').text()).toContain('Invalid bodyText');
    await w.find('[data-test="draft-body"]').setValue('corrected');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(commands).toHaveLength(2);
    expect(commands[0]?.content.bodyText).toBe('too long');
    expect(commands[1]?.content.bodyText).toBe('corrected');
    expect(commands[1]?.requestId).not.toBe(commands[0]?.requestId);
    expect(await fake.listDrafts()).toHaveLength(1);
  });

  it('lets a corrected Save-as-new copy use a fresh request after validation rejects the prior payload', async () => {
    const fake = createBrowserFakeMailClient();
    const creates: Array<Parameters<MailClient['createDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      createDraft: (command) => {
        creates.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['createDraft']>[0]);
        return creates.length === 2
          ? Promise.reject({ kind: 'invalid_request', field: 'bodyText' })
          : fake.createDraft(command);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    const original = (await fake.listDrafts())[0]!;
    const saved = await fake.getDraft(original.ref);
    await fake.saveDraft({ ref: original.ref, expectedRevision: saved.revision, requestId: 'external-copy', content: { ...saved.content, subject: 'changed outside' } });
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('copy can be repaired');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="draft-error"]').text()).toContain('Invalid bodyText');
    await w.find('[data-test="draft-body"]').setValue('corrected copy');
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    expect(creates).toHaveLength(3);
    expect(creates[1]?.initialContent?.bodyText).toBe('copy can be repaired');
    expect(creates[2]?.initialContent?.bodyText).toBe('corrected copy');
    expect(creates[2]?.requestId).not.toBe(creates[1]?.requestId);
    const local = await fake.listDrafts();
    expect(local).toHaveLength(2);
    expect((await fake.getDraft(local.find((draft) => draft.ref.draftId !== original.ref.draftId)!.ref)).content.bodyText).toBe('corrected copy');
  });

  it('retires an abandoned Save-as-new retry before a later conflict copy', async () => {
    const fake = createBrowserFakeMailClient();
    const creates: Array<Parameters<MailClient['createDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      createDraft: (command) => {
        creates.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['createDraft']>[0]);
        return creates.length === 2 ? Promise.reject({ kind: 'storage_unavailable' }) : fake.createDraft(command);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    const original = (await fake.listDrafts())[0]!;
    let current = await fake.getDraft(original.ref);
    await fake.saveDraft({ ref: original.ref, expectedRevision: current.revision, requestId: 'copy-abandon-one', content: { ...current.content, subject: 'first conflict' } });
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('first copy payload');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="draft-error"]').text()).toContain('Local storage did not confirm');

    await w.find('[data-test="ask-reload"]').trigger('click');
    await w.find('[data-test="confirm-reload"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    current = await fake.getDraft(original.ref);
    await fake.saveDraft({ ref: original.ref, expectedRevision: current.revision, requestId: 'copy-abandon-two', content: { ...current.content, subject: 'second conflict' } });
    await flushPromises();
    await w.find(`[data-test="open-draft-${original.ref.draftId}"]`).trigger('click');
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('second copy payload');
    current = await fake.getDraft(original.ref);
    await fake.saveDraft({ ref: original.ref, expectedRevision: current.revision, requestId: 'copy-abandon-three', content: { ...current.content, subject: 'third conflict' } });
    await flushPromises();
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();

    expect(creates).toHaveLength(3);
    expect(creates[1]?.initialContent?.bodyText).toBe('first copy payload');
    expect(creates[2]?.initialContent?.bodyText).toBe('second copy payload');
    expect(creates[2]?.requestId).not.toBe(creates[1]?.requestId);
  });

  it('does not silently rebase local edits when a create follow-up read sees a newer revision', async () => {
    const fake = createBrowserFakeMailClient();
    const read = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
    let receipt: DraftReceipt | null = null;
    let firstRead = true;
    const client: MailClient = {
      ...fake,
      createDraft: async (command) => { receipt = await fake.createDraft(command); return receipt; },
      getDraft: (ref) => {
        if (firstRead) { firstRead = false; return read.promise; }
        return fake.getDraft(ref);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await w.find('[data-test="new-draft"]').trigger('click');
    await advanceUiUntil(() => receipt !== null);
    await advanceUiUntil(() => w.find('[data-test="composer"]').exists());
    await w.find('[data-test="draft-body"]').setValue('local edit during create recovery');
    const created = receipt!;
    const stored = await fake.getDraft(created.ref);
    await fake.saveDraft({ ref: created.ref, expectedRevision: stored.revision, requestId: 'external-create-race', content: { ...stored.content, subject: 'saved by another client' } });
    read.resolve(await fake.getDraft(created.ref));
    await flushPromises();
    expect(w.find('[data-test="draft-conflict-actions"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('local edit during create recovery');
    expect(w.find('[data-test="draft-error"]').text()).toContain('another save created revision 2');
  });

  it.each([
    ['deleted', 'native close'],
    ['newer write', 'native close'],
    ['deleted', 'editor close'],
    ['newer write', 'editor switch'],
    ['newer write', 'account transition'],
  ] as const)('does not trust a historical save receipt after a %s during %s', async (race, action) => {
    const fake = createBrowserFakeMailClient();
    if (action === 'account transition') {
      fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'read_only' });
    }
    const commands: Array<Parameters<MailClient['saveDraft']>[0]> = [];
    let disconnects = 0;
    const client: MailClient = {
      ...fake,
      saveDraft: async (command) => {
        commands.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['saveDraft']>[0]);
        if (commands.length === 1) {
          await fake.saveDraft(command);
          throw { kind: 'storage_unavailable' }; // The revision committed; only its ACK was lost.
        }
        return fake.saveDraft(command); // Replays the historical receipt for the frozen request.
      },
      disconnectAccount: async () => { disconnects += 1; await fake.disconnectAccount(); },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('only surviving exact local buffer');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(commands).toHaveLength(1);
    const frozen = commands[0]!;
    const originalReceipt = await fake.getDraft(frozen.ref);
    expect(originalReceipt).toMatchObject({ revision: 2, content: { bodyText: frozen.content.bodyText } });

    if (race === 'deleted') {
      await fake.deleteDraft({ ref: frozen.ref, expectedRevision: originalReceipt.revision, requestId: `historical-delete-${action}` });
    } else {
      await fake.saveDraft({
        ref: frozen.ref,
        expectedRevision: originalReceipt.revision,
        requestId: `historical-newer-save-${action}`,
        content: { ...frozen.content, bodyText: 'different text saved elsewhere' },
      });
    }

    if (action === 'native close') fake.controls.requestAppClose();
    else if (action === 'editor close') await w.find('[data-test="close-composer"]').trigger('click');
    else if (action === 'editor switch') await requestEditorSwitch(w);
    else {
      // The flush fails, so the guarded switch away from Drafts aborts and the
      // user never reaches the Account drawer or its disconnect controls.
      await openUtilityDrawer(w, 'account');
    }
    await flushPromises();
    // The blocked disconnect keeps the editor; return to its visible surface.
    if (action === 'account transition') await openUtilityDrawer(w, 'drafts');

    if (action === 'native close') {
      await advanceUiUntil(() => fake.controls.pendingAppClose() === null);
      expect(fake.controls.completedCloseCount()).toBe(0);
    }
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(frozen);
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('only surviving exact local buffer');
    expect(w.find('[data-test="save-as-new"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-status"]').text()).not.toMatch(/Saved in preview memory/);
    expect(w.find('.composer-fields').attributes('aria-busy')).toBe('false');
    expect(disconnects).toBe(0);
    if (race === 'deleted') {
      expect(w.find('[data-test="deleted-draft-recovery"]').exists()).toBe(true);
      expect(await fake.listDrafts()).toEqual([]);
    } else {
      expect(w.find('[data-test="draft-conflict-actions"]').exists()).toBe(true);
      expect(await fake.getDraft(frozen.ref)).toMatchObject({ revision: 3, content: { bodyText: 'different text saved elsewhere' } });
    }

    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    const recovered = (await fake.listDrafts()).find((draft) => draft.ref.draftId !== frozen.ref.draftId)!;
    expect(recovered).toBeDefined();
    expect(await fake.getDraft(recovered.ref)).toMatchObject({ content: { bodyText: 'only surviving exact local buffer' } });
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
  });

  it('retries the same frozen save when the live-state verification read fails', async () => {
    const fake = createBrowserFakeMailClient();
    const commands: Array<Parameters<MailClient['saveDraft']>[0]> = [];
    let readsForSave = 0;
    const client: MailClient = {
      ...fake,
      saveDraft: async (command) => {
        commands.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['saveDraft']>[0]);
        return fake.saveDraft(command);
      },
      getDraft: (ref) => {
        if (commands.length && ref.draftId === commands[0]?.ref.draftId && readsForSave++ === 0) {
          return Promise.reject({ kind: 'storage_unavailable' });
        }
        return fake.getDraft(ref);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('saved but not yet verified');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-error"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-status"]').text()).not.toMatch(/Saved in preview memory/);
    expect(await fake.getDraft(commands[0]!.ref)).toMatchObject({ content: { bodyText: 'saved but not yet verified' } });

    await w.find('[data-test="retry-draft-save"]').trigger('click');
    await flushPromises();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect((w.find('[data-test="draft-status"]').text())).toBe('Saved in preview memory (non-durable) · not sent');
    expect(await fake.getDraft(commands[0]!.ref)).toMatchObject({ revision: 2, content: { bodyText: 'saved but not yet verified' } });
  });

  it('persists edits made while save verification is delayed before editor close', async () => {
    const fake = createBrowserFakeMailClient();
    const verification = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
    const commands: Array<Parameters<MailClient['saveDraft']>[0]> = [];
    let holdVerification = false;
    const client: MailClient = {
      ...fake,
      saveDraft: async (command) => {
        commands.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['saveDraft']>[0]);
        const receipt = await fake.saveDraft(command);
        if (commands.length === 1) holdVerification = true;
        return receipt;
      },
      getDraft: (ref) => {
        if (holdVerification && ref.draftId === commands[0]?.ref.draftId) {
          holdVerification = false;
          return verification.promise;
        }
        return fake.getDraft(ref);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('first frozen version');
    const closing = w.find('[data-test="close-composer"]').trigger('click');
    await advanceUiUntil(() => commands.length === 1 && !holdVerification);
    const frozen = commands[0]!;
    const firstStoredVersion = await fake.getDraft(frozen.ref);
    expect(firstStoredVersion.content.bodyText).toBe('first frozen version');
    expect(w.find('[data-test="composer"]').exists()).toBe(true);

    await w.find('[data-test="draft-body"]').setValue('newest edit during verification');
    verification.resolve(firstStoredVersion);
    await closing;
    await flushPromises();

    expect(commands).toHaveLength(2);
    expect(commands[1]?.content.bodyText).toBe('newest edit during verification');
    expect(commands[1]?.expectedRevision).toBe(2);
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
    expect(await fake.getDraft(frozen.ref)).toMatchObject({ revision: 3, content: { bodyText: 'newest edit during verification' } });
  });

  it('retains the frozen retry across an account change during delayed save verification', async () => {
    const fake = createBrowserFakeMailClient();
    const verification = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
    const commands: Array<Parameters<MailClient['saveDraft']>[0]> = [];
    let verificationSnapshot: Awaited<ReturnType<MailClient['getDraft']>> | null = null;
    let holdVerification = false;
    const client: MailClient = {
      ...fake,
      saveDraft: async (command) => {
        commands.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['saveDraft']>[0]);
        const receipt = await fake.saveDraft(command);
        if (commands.length === 1) {
          verificationSnapshot = await fake.getDraft(command.ref);
          holdVerification = true;
        }
        return receipt;
      },
      getDraft: (ref) => {
        if (holdVerification && ref.draftId === commands[0]?.ref.draftId) {
          holdVerification = false;
          return verification.promise;
        }
        return fake.getDraft(ref);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('frozen before account transition');
    const closing = w.find('[data-test="close-composer"]').trigger('click');
    await advanceUiUntil(() => verificationSnapshot !== null && !holdVerification);
    await w.find('[data-test="draft-body"]').setValue('newer buffer kept across account transition');
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'other@example.test', mutationAccess: 'read_only' });
    await advanceUiUntil(() => !w.find('[data-test="composer"]').exists());
    verification.resolve(verificationSnapshot!);
    await closing;
    await flushPromises();

    fake.controls.setAccount({ mode: 'fixture', connection: 'connected', emailAddress: 'you@fixture.emailos' });
    await advanceUiUntil(() => w.find('[data-test="composer"]').exists());
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('newer buffer kept across account transition');
    expect(w.find('[data-test="draft-status"]').text()).toContain('Saving locally');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();

    expect(commands).toHaveLength(3);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[2]?.content.bodyText).toBe('newer buffer kept across account transition');
    expect(commands[2]?.expectedRevision).toBe(2);
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
    expect(await fake.getDraft(commands[0]!.ref)).toMatchObject({ revision: 3, content: { bodyText: 'newer buffer kept across account transition' } });
  });

  it('recovers an acknowledged create when its follow-up read finds the ref deleted', async () => {
    const fake = createBrowserFakeMailClient();
    const read = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
    let receipt: DraftReceipt | null = null;
    let holdFirstRead = true;
    const client: MailClient = {
      ...fake,
      createDraft: async (command) => { receipt = await fake.createDraft(command); return receipt; },
      getDraft: (ref) => {
        if (holdFirstRead) { holdFirstRead = false; return read.promise; }
        return fake.getDraft(ref);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await w.find('[data-test="new-draft"]').trigger('click');
    await advanceUiUntil(() => receipt !== null);
    await advanceUiUntil(() => w.find('[data-test="draft-body"]').exists());
    await w.find('[data-test="draft-body"]').setValue('buffer survives deleted create ref');
    const deletedRef = { ...receipt!.ref };
    await fake.deleteDraft({ ref: deletedRef, expectedRevision: receipt!.revision, requestId: 'delete-during-create-read' });
    read.reject({ kind: 'not_found' });
    await flushPromises();

    expect(w.find('[data-test="deleted-draft-recovery"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('buffer survives deleted create ref');
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    const remaining = await fake.listDrafts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.ref.draftId).not.toBe(deletedRef.draftId);
    expect((await fake.getDraft(remaining[0]!.ref)).content.bodyText).toBe('buffer survives deleted create ref');
  });

  it('keeps the editor open after a deleted recovery-copy receipt and requires a fresh explicit copy', async () => {
    const fake = createBrowserFakeMailClient();
    const source = await fake.createDraft({
      requestId: 'copy-tombstone-source',
      source: { kind: 'new_message' },
      initialContent: { to: '', cc: '', subject: 'source', bodyText: '' },
    });
    const creates: Array<Parameters<MailClient['createDraft']>[0]> = [];
    let committedCopy: DraftReceipt | null = null;
    const client: MailClient = {
      ...fake,
      createDraft: async (command) => {
        creates.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['createDraft']>[0]);
        if (creates.length === 1) {
          committedCopy = await fake.createDraft(command);
          throw { kind: 'storage_unavailable' }; // committed, but the first ACK is lost
        }
        if (creates.length === 2) {
          const historicalReceipt = await fake.createDraft(command);
          await fake.deleteDraft({ ref: historicalReceipt.ref, expectedRevision: historicalReceipt.revision, requestId: 'delete-committed-copy-before-retry' });
          return historicalReceipt;
        }
        return fake.createDraft(command);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await w.find(`[data-test="open-draft-${source.ref.draftId}"]`).trigger('click');
    await flushPromises();
    await fake.deleteDraft({ ref: source.ref, expectedRevision: source.revision, requestId: 'delete-tombstone-source' });
    await w.find('[data-test="draft-body"]').setValue('sole surviving exact text');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="draft-error"]').exists()).toBe(true);
    expect(committedCopy).not.toBeNull();

    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(creates).toHaveLength(2);
    expect(creates[1]).toEqual(creates[0]);
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('sole surviving exact text');
    expect(w.find('[data-test="deleted-draft-recovery"]').exists()).toBe(true);
    expect(await fake.listDrafts()).toEqual([]);
    fake.controls.requestAppClose();
    await advanceUiUntil(() => fake.controls.pendingAppClose() === null);
    expect(fake.controls.completedCloseCount()).toBe(0);
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    const unload = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    expect(await fake.listDrafts()).toEqual([]);
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    expect(creates).toHaveLength(3);
    expect(creates[2]?.requestId).not.toBe(creates[0]?.requestId);
    const remaining = await fake.listDrafts();
    expect(remaining).toHaveLength(1);
    expect((await fake.getDraft(remaining[0]!.ref)).content.bodyText).toBe('sole surviving exact text');
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('sole surviving exact text');
  });

  it.each(['acknowledgement', 'rejection'] as const)(
    'keeps explicit copy recovery available after a late original-save %s', async (lateOutcome) => {
      const fake = createBrowserFakeMailClient();
      const oldRetry = deferred<DraftReceipt>();
      const verification = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
      const saves: Array<Parameters<MailClient['saveDraft']>[0]> = [];
      const creates: Array<Parameters<MailClient['createDraft']>[0]> = [];
      let recovered: DraftReceipt | null = null;
      let verificationDraftId: string | null = null;
      const client: MailClient = {
        ...fake,
        saveDraft: (command) => {
          saves.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['saveDraft']>[0]);
          return saves.length === 1 ? Promise.reject({ kind: 'not_found' }) : oldRetry.promise;
        },
        createDraft: async (command) => {
          creates.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['createDraft']>[0]);
          const receipt = await fake.createDraft(command);
          if (creates.length === 2) {
            recovered = receipt;
            verificationDraftId = receipt.ref.draftId;
          }
          return receipt;
        },
        getDraft: (ref) => ref.draftId === verificationDraftId ? verification.promise : fake.getDraft(ref),
      };
      const w = wrapper = await mountDraftsUi(fake, client);
      await startNewDraft(w);
      const original = (await fake.listDrafts())[0]!;
      await fake.deleteDraft({ ref: original.ref, expectedRevision: original.revision, requestId: `late-save-${lateOutcome}-delete-original` });
      await w.find('[data-test="draft-body"]').setValue('latest exact recovery buffer');
      await w.find('[data-test="close-composer"]').trigger('click');
      await flushPromises();
      expect(w.find('[data-test="save-as-new"]').exists()).toBe(true);

      const copyButton = w.find('[data-test="save-as-new"]');
      await w.find('[data-test="retry-draft-save"]').trigger('click');
      copyButton.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushPromises();
      expect(saves).toHaveLength(2);
      await advanceUiUntil(() => recovered !== null);
      await fake.deleteDraft({ ref: recovered!.ref, expectedRevision: recovered!.revision, requestId: `late-save-${lateOutcome}-delete-copy` });
      verification.reject({ kind: 'not_found' });
      await flushPromises();
      expect(w.find('[data-test="save-as-new"]').exists()).toBe(true);
      expect(w.find('[data-test="retry-draft-save"]').exists()).toBe(false);

      if (lateOutcome === 'acknowledgement') {
        oldRetry.resolve({ ref: original.ref, revision: original.revision + 1, savedAt: '2025-01-01T00:00:00Z' });
      } else {
        oldRetry.reject({ kind: 'storage_unavailable' });
      }
      await flushPromises();
      expect(w.find('[data-test="save-as-new"]').exists()).toBe(true);
      expect(w.find('[data-test="retry-draft-save"]').exists()).toBe(false);
      expect(w.find('[data-test="draft-error"]').text()).toContain('no longer available');
      expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('latest exact recovery buffer');

      await w.find('[data-test="close-composer"]').trigger('click');
      await flushPromises();
      expect(w.find('[data-test="composer"]').exists()).toBe(true);
      fake.controls.requestAppClose();
      await advanceUiUntil(() => fake.controls.pendingAppClose() === null);
      expect(fake.controls.completedCloseCount()).toBe(0);
      expect(await fake.listDrafts()).toEqual([]);

      await w.find('[data-test="save-as-new"]').trigger('click');
      await flushPromises();
      expect(creates).toHaveLength(3);
      expect(creates[2]?.requestId).not.toBe(creates[1]?.requestId);
      const remaining = await fake.listDrafts();
      expect(remaining).toHaveLength(1);
      expect((await fake.getDraft(remaining[0]!.ref)).content.bodyText).toBe('latest exact recovery buffer');
      expect(w.find('[data-test="draft-status"]').text()).toBe('Saved in preview memory (non-durable) · not sent');
      const unload = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
      window.dispatchEvent(unload);
      expect(unload.defaultPrevented).toBe(false);
    },
  );

  it('surfaces a recovery copy revision race without replacing the local buffer', async () => {
    const fake = createBrowserFakeMailClient();
    const source = await fake.createDraft({
      requestId: 'copy-verification-race-source',
      source: { kind: 'new_message' },
      initialContent: { to: '', cc: '', subject: 'source', bodyText: '' },
    });
    const read = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
    let recoveredRef: DraftReceipt['ref'] | null = null;
    const client: MailClient = {
      ...fake,
      createDraft: async (command) => {
        const receipt = await fake.createDraft(command);
        if (command.source.kind === 'new_message' && command.initialContent?.bodyText === 'local recovery text') recoveredRef = receipt.ref;
        return receipt;
      },
      getDraft: (ref) => recoveredRef?.draftId === ref.draftId ? read.promise : fake.getDraft(ref),
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await w.find(`[data-test="open-draft-${source.ref.draftId}"]`).trigger('click');
    await flushPromises();
    await fake.deleteDraft({ ref: source.ref, expectedRevision: source.revision, requestId: 'delete-verification-race-source' });
    await w.find('[data-test="draft-body"]').setValue('local recovery text');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="save-as-new"]').trigger('click');
    await advanceUiUntil(() => recoveredRef !== null);
    const recovered = await fake.getDraft(recoveredRef!);
    await fake.saveDraft({
      ref: recovered.ref,
      expectedRevision: recovered.revision,
      requestId: 'external-recovery-copy-save',
      content: { ...recovered.content, bodyText: 'newer external text' },
    });
    read.resolve(await fake.getDraft(recovered.ref));
    await flushPromises();
    expect(w.find('[data-test="draft-conflict-actions"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-error"]').text()).toContain('another save created revision 2');
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('local recovery text');
    expect((await fake.getDraft(recovered.ref)).content.bodyText).toBe('newer external text');
  });

  it('keeps edits made during recovery-copy verification and flushes them to the verified ref', async () => {
    const fake = createBrowserFakeMailClient();
    const source = await fake.createDraft({
      requestId: 'copy-buffer-verification-source',
      source: { kind: 'new_message' },
      initialContent: { to: '', cc: '', subject: 'source', bodyText: '' },
    });
    const read = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
    let recoveredRef: DraftReceipt['ref'] | null = null;
    let holdCopyRead = true;
    const client: MailClient = {
      ...fake,
      createDraft: async (command) => {
        const receipt = await fake.createDraft(command);
        if (command.source.kind === 'new_message' && command.initialContent?.bodyText === 'copy snapshot') recoveredRef = receipt.ref;
        return receipt;
      },
      getDraft: (ref) => {
        if (holdCopyRead && recoveredRef?.draftId === ref.draftId) {
          holdCopyRead = false;
          return read.promise;
        }
        return fake.getDraft(ref);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await w.find(`[data-test="open-draft-${source.ref.draftId}"]`).trigger('click');
    await flushPromises();
    await fake.deleteDraft({ ref: source.ref, expectedRevision: source.revision, requestId: 'delete-buffer-verification-source' });
    await w.find('[data-test="draft-body"]').setValue('copy snapshot');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="save-as-new"]').trigger('click');
    await advanceUiUntil(() => recoveredRef !== null);
    await w.find('[data-test="draft-body"]').setValue('latest edit during verification');
    read.resolve(await fake.getDraft(recoveredRef!));
    await flushPromises();
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('latest edit during verification');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
    expect((await fake.getDraft(recoveredRef!)).content.bodyText).toBe('latest edit during verification');
  });

  it.each(['rejection', 'acknowledgement'] as const)('ignores an old-ref save %s after installing a Save-as-new recovery copy', async (oldOutcome) => {
    const fake = createBrowserFakeMailClient();
    const oldRetry = deferred<DraftReceipt>();
    const copyReceipt = deferred<DraftReceipt>();
    const newSave = deferred<DraftReceipt>();
    const creates: Array<Parameters<MailClient['createDraft']>[0]> = [];
    const saves: Array<Parameters<MailClient['saveDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      createDraft: (command) => {
        creates.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['createDraft']>[0]);
        return creates.length === 2 ? copyReceipt.promise : fake.createDraft(command);
      },
      saveDraft: (command) => {
        saves.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['saveDraft']>[0]);
        if (saves.length === 1) return Promise.reject({ kind: 'not_found' });
        if (saves.length === 2) return oldRetry.promise;
        if (saves.length === 3) return newSave.promise;
        return fake.saveDraft(command);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    const original = (await fake.listDrafts())[0]!;
    await fake.deleteDraft({ ref: original.ref, expectedRevision: original.revision, requestId: 'delete-before-copy-race' });
    await w.find('[data-test="draft-body"]').setValue('first recovery buffer');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="deleted-draft-recovery"]').exists()).toBe(true);

    const copyButton = w.find('[data-test="save-as-new"]');
    w.find('[data-test="retry-draft-save"]').element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    copyButton.element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(saves).toHaveLength(2);
    expect(creates).toHaveLength(2);
    await w.find('[data-test="draft-body"]').setValue('newer text for recovery copy');
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    // New-ref autosave waits for the in-flight copy instead of retrying the old ref.
    expect(saves).toHaveLength(2);
    const recovered = await fake.createDraft(creates[1]!);
    copyReceipt.resolve(recovered);
    await advanceUiUntil(() => saves.length === 3);
    const copiedSave = saves[2]!;
    expect(copiedSave.ref.draftId).toBe(recovered.ref.draftId);
    const copiedReceipt = await fake.saveDraft(copiedSave);
    newSave.resolve(copiedReceipt);
    await flushPromises();
    expect(await fake.getDraft(recovered.ref)).toMatchObject({ revision: copiedReceipt.revision, content: { bodyText: 'newer text for recovery copy' } });

    if (oldOutcome === 'rejection') oldRetry.reject({ kind: 'not_found' });
    else oldRetry.resolve({ ref: original.ref, revision: original.revision + 1, savedAt: '2025-01-01T00:00:00Z' });
    await flushPromises();
    expect(w.find('[data-test="draft-error"]').exists()).toBe(false);
    expect(w.find('[data-test="draft-status"]').text()).toBe('Saved in preview memory (non-durable) · not sent');
    const unload = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
    const remaining = await fake.listDrafts();
    expect(remaining).toHaveLength(1);
    expect((await fake.getDraft(remaining[0]!.ref)).content.bodyText).toBe('newer text for recovery copy');
  });

  it.each(['native close', 'editor close', 'editor switch', 'account transition'] as const)(
    'waits for a recovery-copy receipt before %s clears or changes the editor', async (action) => {
      const fake = createBrowserFakeMailClient();
      if (action === 'account transition') {
        fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'read_only' });
      }
      const source = await fake.createDraft({
        requestId: `copy-close-${action}`,
        source: { kind: 'new_message' },
        initialContent: { to: '', cc: '', subject: 'valuable original', bodyText: 'only remaining exact text' },
      });
      const copyAck = deferred<DraftReceipt>();
      const creates: Array<Parameters<MailClient['createDraft']>[0]> = [];
      let disconnects = 0;
      const client: MailClient = {
        ...fake,
        createDraft: (command) => {
          creates.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['createDraft']>[0]);
          return creates.length === 1 ? copyAck.promise : fake.createDraft(command);
        },
        disconnectAccount: async () => { disconnects += 1; await fake.disconnectAccount(); },
      };
      const w = wrapper = await mountDraftsUi(fake, client);
      await w.find(`[data-test="open-draft-${source.ref.draftId}"]`).trigger('click');
      await flushPromises();
      await fake.deleteDraft({ ref: source.ref, expectedRevision: source.revision, requestId: `copy-delete-${action}` });
      await w.find('[data-test="discard-draft"]').trigger('click');
      await w.find('[data-test="confirm-discard"]').trigger('click');
      await flushPromises();
      expect(w.find('[data-test="deleted-draft-recovery"]').exists()).toBe(true);
      await w.find('[data-test="save-as-new"]').trigger('click');
      await flushPromises();
      expect(creates).toHaveLength(1);

      if (action === 'native close') {
        fake.controls.requestAppClose();
      } else if (action === 'editor close') {
        await w.find('[data-test="close-composer"]').trigger('click');
      } else if (action === 'editor switch') {
        await requestEditorSwitch(w);
      } else {
        // The flush fails, so the guarded switch away from Drafts aborts and the
        // user never reaches the Account drawer or its disconnect controls.
        await openUtilityDrawer(w, 'account');
      }
      await flushPromises();
      // The blocked switch keeps the editor on the already-visible drafts surface.
      expect(w.find('[data-test="composer"]').exists()).toBe(true);
      expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('only remaining exact text');
      const unloadWhileCopyPending = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
      window.dispatchEvent(unloadWhileCopyPending);
      expect(unloadWhileCopyPending.defaultPrevented).toBe(true);
      expect(fake.controls.completedCloseCount()).toBe(0);
      expect(disconnects).toBe(0);
      expect(creates).toHaveLength(1);

      const copied = await fake.createDraft(creates[0]!);
      copyAck.resolve(copied);
      if (action === 'native close') await advanceUiUntil(() => fake.controls.completedCloseCount() === 1);
      else if (action === 'account transition') {
        await openUtilityDrawer(w, 'account');
        // The flush succeeded, so the switch completes and the user can now
        // reach the disconnect controls on the Account surface.
        await w.find('[data-test="account-disconnect"]').trigger('click');
        await advanceUiUntil(() => w.find('[data-test="account-connect"]').exists());
      }
      else if (action === 'editor switch') await advanceUiUntil(() => creates.length === 2 && w.find('[data-test="composer"]').exists());
      else await advanceUiUntil(() => !w.find('[data-test="composer"]').exists());

      if (action === 'account transition') {
        expect(disconnects).toBe(1);
        await w.find('[data-test="account-connect"]').trigger('click');
        await flushPromises();
        await openUtilityDrawer(w, 'drafts');
        await advanceUiUntil(() => w.find(`[data-test="open-draft-${copied.ref.draftId}"]`).exists());
      }
      expect(await fake.getDraft(copied.ref)).toMatchObject({ content: { subject: 'valuable original', bodyText: 'only remaining exact text' } });
      if (action === 'editor switch') expect(creates[1]?.initialContent).toEqual({ to: '', cc: '', subject: '', bodyText: '' });
    },
  );

  it('keeps Save-as-new validation correction enabled for sequential input edits', async () => {
    const fake = createBrowserFakeMailClient();
    const creates: Array<Parameters<MailClient['createDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      createDraft: (command) => {
        creates.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['createDraft']>[0]);
        return creates.length === 2
          ? Promise.reject({ kind: 'invalid_request', field: 'bodyText' })
          : fake.createDraft(command);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    const original = (await fake.listDrafts())[0]!;
    await fake.saveDraft({ ref: original.ref, expectedRevision: original.revision, requestId: 'sequential-correction-conflict', content: { to: '', cc: '', subject: 'external change', bodyText: '' } });
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('repair me');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="draft-error"]').text()).toContain('Invalid bodyText');

    const body = w.find('[data-test="draft-body"]');
    const inputBackspace = async () => {
      const element = body.element as HTMLTextAreaElement;
      element.value = element.value.slice(0, -1);
      await body.trigger('input');
      await flushPromises();
      expect((body.element as HTMLTextAreaElement).disabled).toBe(false);
    };
    await inputBackspace();
    await inputBackspace();
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    const copies = await fake.listDrafts();
    expect(copies).toHaveLength(2);
    expect((await fake.getDraft(copies.find((draft) => draft.ref.draftId !== original.ref.draftId)!.ref)).content.bodyText).toBe('repair ');
  });

  it('allows confirmed discard after an invalid buffer is definitively rejected', async () => {
    const fake = createBrowserFakeMailClient();
    let saveCalls = 0;
    const client: MailClient = {
      ...fake,
      saveDraft: (command) => { saveCalls += 1; return fake.saveDraft(command); },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('x'.repeat(1024 * 1024 + 1));
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="draft-error"]').text()).toContain('Invalid bodyText');
    expect(saveCalls).toBe(1);

    await w.find('[data-test="discard-draft"]').trigger('click');
    await w.find('[data-test="confirm-discard"]').trigger('click');
    await flushPromises();
    expect(await fake.listDrafts()).toEqual([]);
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
    expect(saveCalls).toBe(1);
  });

  it('recovers a dirty buffer as a new draft after another client deletes its saved ref', async () => {
    const fake = createBrowserFakeMailClient();
    const w = wrapper = await mountDraftsUi(fake);
    await startNewDraft(w);
    const original = (await fake.listDrafts())[0]!;
    const saved = await fake.getDraft(original.ref);
    // Re-opening the already-open draft: the one-column drawer shows no list, so the request comes from the panel event.
    await requestEditorSwitch(w, original.ref);
    await fake.deleteDraft({ ref: original.ref, expectedRevision: saved.revision, requestId: 'delete-elsewhere' });
    await w.find('[data-test="draft-body"]').setValue('recover text without resurrecting old ref');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="deleted-draft-recovery"]').text()).toContain('deleted elsewhere');
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    const remaining = await fake.listDrafts();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.ref.draftId).not.toBe(original.ref.draftId);
    expect((await fake.getDraft(remaining[0]!.ref)).content.bodyText).toBe('recover text without resurrecting old ref');
  });

  it('retries an uncertain delete with the exact same revision-checked command', async () => {
    const fake = createBrowserFakeMailClient();
    const deletions: Array<Parameters<MailClient['deleteDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      deleteDraft: async (command) => {
        deletions.push(JSON.parse(JSON.stringify(command)) as Parameters<MailClient['deleteDraft']>[0]);
        const receipt = await fake.deleteDraft(command);
        if (deletions.length === 1) throw { kind: 'storage_unavailable' };
        return receipt;
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    await w.find('[data-test="discard-draft"]').trigger('click');
    await w.find('[data-test="confirm-discard"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="retry-draft-save"]').text()).toContain('Retry discard');
    expect(w.find('[data-test="confirm-discard"]').exists()).toBe(false);
    expect(w.find('[data-test="cancel-discard"]').exists()).toBe(false);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).disabled).toBe(true);
    await w.find('[data-test="retry-draft-save"]').trigger('click');
    await flushPromises();
    expect(deletions).toHaveLength(2);
    expect(deletions[1]).toEqual(deletions[0]);
    expect(await fake.listDrafts()).toEqual([]);
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
  });

  it('reloads a conflicting saved version only after explicit confirmation', async () => {
    const fake = createBrowserFakeMailClient();
    const w = wrapper = await mountDraftsUi(fake);
    await startNewDraft(w);
    const created = (await fake.listDrafts())[0]!;
    const draft = await fake.getDraft(created.ref);
    await fake.saveDraft({ ref: created.ref, expectedRevision: draft.revision, requestId: 'external-reload', content: { ...draft.content, bodyText: 'saved elsewhere' } });
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('keep my exact edit');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="draft-conflict-actions"]').exists()).toBe(true);
    await w.find('[data-test="ask-reload"]').trigger('click');
    expect(w.find('[data-test="confirm-reload"]').exists()).toBe(true);
    await w.find('[data-test="cancel-reload"]').trigger('click');
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('keep my exact edit');
    await w.find('[data-test="ask-reload"]').trigger('click');
    await w.find('[data-test="confirm-reload"]').trigger('click');
    await flushPromises();
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('saved elsewhere');
    expect(w.find('[data-test="draft-conflict-actions"]').exists()).toBe(false);
  });

  it('keeps text when Keep my text cancels a delayed confirmed reload', async () => {
    const fake = createBrowserFakeMailClient();
    const delayedRead = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
    let delayRead = false;
    const client: MailClient = {
      ...fake,
      getDraft: (ref) => {
        if (delayRead) { delayRead = false; return delayedRead.promise; }
        return fake.getDraft(ref);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    const original = (await fake.listDrafts())[0]!;
    const stored = await fake.getDraft(original.ref);
    await fake.saveDraft({ ref: original.ref, expectedRevision: stored.revision, requestId: 'delayed-reload-cancel', content: { ...stored.content, bodyText: 'remote saved text' } });
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('keep my exact local text');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="draft-conflict-actions"]').exists()).toBe(true);

    delayRead = true;
    await w.find('[data-test="ask-reload"]').trigger('click');
    await w.find('[data-test="confirm-reload"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="cancel-reload"]').trigger('click');
    delayedRead.resolve(await fake.getDraft(original.ref));
    await flushPromises();

    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('keep my exact local text');
    expect(w.find('[data-test="draft-conflict-actions"]').exists()).toBe(true);
  });

  it.each([true, false])('keeps the copy payload when delayed reload and copy ACK resolve in either order: %s', async (reloadBeforeCopyAck) => {
    const fake = createBrowserFakeMailClient();
    const delayedRead = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
    const copyAck = deferred<DraftReceipt>();
    let delayRead = false;
    let originalDraftId: string | null = null;
    let createCalls = 0;
    const copyCommand: { value: Parameters<MailClient['createDraft']>[0] | null } = { value: null };
    const client: MailClient = {
      ...fake,
      getDraft: (ref) => {
        if (delayRead && ref.draftId === originalDraftId) { delayRead = false; return delayedRead.promise; }
        return fake.getDraft(ref);
      },
      createDraft: (command) => {
        if (createCalls++ === 1) {
          copyCommand.value = JSON.parse(JSON.stringify(command)) as Parameters<MailClient['createDraft']>[0];
          return copyAck.promise;
        }
        return fake.createDraft(command);
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    const original = (await fake.listDrafts())[0]!;
    originalDraftId = original.ref.draftId;
    const stored = await fake.getDraft(original.ref);
    await fake.saveDraft({ ref: original.ref, expectedRevision: stored.revision, requestId: `delayed-reload-copy-${reloadBeforeCopyAck}`, content: { ...stored.content, bodyText: 'remote saved text' } });
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('copy this local text');
    await w.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    delayRead = true;
    await w.find('[data-test="ask-reload"]').trigger('click');
    await w.find('[data-test="confirm-reload"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="save-as-new"]').trigger('click');
    await flushPromises();
    expect(copyCommand.value?.initialContent?.bodyText).toBe('copy this local text');

    if (reloadBeforeCopyAck) {
      delayedRead.resolve(await fake.getDraft(original.ref));
      await flushPromises();
    }
    copyAck.resolve(await fake.createDraft(copyCommand.value!));
    await flushPromises();
    if (!reloadBeforeCopyAck) {
      delayedRead.resolve(await fake.getDraft(original.ref));
      await flushPromises();
    }

    const drafts = await fake.listDrafts();
    expect(drafts).toHaveLength(2);
    const copy = drafts.find((draft) => draft.ref.draftId !== original.ref.draftId)!;
    expect((await fake.getDraft(copy.ref)).content.bodyText).toBe('copy this local text');
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('copy this local text');
    expect(w.find('[data-test="draft-conflict-actions"]').exists()).toBe(false);
  });

  it('Keep draft cancels a discard intent while its dirty-save flush is deferred', async () => {
    const fake = createBrowserFakeMailClient();
    const pendingSave = deferred<DraftReceipt>();
    let saveCommand: Parameters<MailClient['saveDraft']>[0] | null = null;
    const deletions: Array<Parameters<MailClient['deleteDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      saveDraft: (command) => { saveCommand = command; return pendingSave.promise; },
      deleteDraft: (command) => { deletions.push(command); return fake.deleteDraft(command); },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    const original = (await fake.listDrafts())[0]!;
    await w.find('[data-test="draft-body"]').setValue('valuable text I decide to keep');
    await w.find('[data-test="discard-draft"]').trigger('click');
    await w.find('[data-test="confirm-discard"]').trigger('click');
    await flushPromises();
    expect(saveCommand).not.toBeNull();
    expect(w.find('[data-test="cancel-discard"]').exists()).toBe(true);
    expect(w.find('[data-test="confirm-discard"]').attributes('disabled')).toBeDefined();

    await w.find('[data-test="cancel-discard"]').trigger('click');
    expect(w.find('[data-test="confirm-discard"]').exists()).toBe(false);
    pendingSave.resolve(await fake.saveDraft(saveCommand!));
    await flushPromises();
    expect(deletions).toEqual([]);
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    expect((await fake.getDraft(original.ref)).content.bodyText).toBe('valuable text I decide to keep');
  });

  it('invalidates a pending discard when switching to another draft ref', async () => {
    const fake = createBrowserFakeMailClient();
    const original = await fake.createDraft({ requestId: 'discard-switch-original', source: { kind: 'new_message' }, initialContent: { to: '', cc: '', subject: 'first', bodyText: '' } });
    const next = await fake.createDraft({ requestId: 'discard-switch-next', source: { kind: 'new_message' }, initialContent: { to: '', cc: '', subject: 'second', bodyText: 'second draft' } });
    const pendingSave = deferred<DraftReceipt>();
    let saveCommand: Parameters<MailClient['saveDraft']>[0] | null = null;
    const deletions: Array<Parameters<MailClient['deleteDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      saveDraft: (command) => { saveCommand = command; return pendingSave.promise; },
      deleteDraft: (command) => { deletions.push(command); return fake.deleteDraft(command); },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await w.find(`[data-test="open-draft-${original.ref.draftId}"]`).trigger('click');
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('first draft text to keep');
    await w.find('[data-test="discard-draft"]').trigger('click');
    await w.find('[data-test="confirm-discard"]').trigger('click');
    await flushPromises();
    expect(saveCommand).not.toBeNull();

    await requestEditorSwitch(w, next.ref);
    expect(w.find('[data-test="confirm-discard"]').exists()).toBe(false);
    pendingSave.resolve(await fake.saveDraft(saveCommand!));
    await flushPromises();
    expect(deletions).toEqual([]);
    expect(w.find('[data-test="draft-subject"]').element).toHaveProperty('value', 'second');
    expect((await fake.getDraft(original.ref)).content.bodyText).toBe('first draft text to keep');
    expect((await fake.getDraft(next.ref)).content.bodyText).toBe('second draft');
  });

  it('removes Keep/second-confirm affordances after revision-checked delete dispatch', async () => {
    const fake = createBrowserFakeMailClient();
    const deleteAck = deferred<void>();
    const deletions: Array<Parameters<MailClient['deleteDraft']>[0]> = [];
    const client: MailClient = {
      ...fake,
      deleteDraft: async (command) => {
        deletions.push(command);
        const receipt = await fake.deleteDraft(command);
        await deleteAck.promise;
        return receipt;
      },
    };
    const w = wrapper = await mountDraftsUi(fake, client);
    await startNewDraft(w);
    await w.find('[data-test="discard-draft"]').trigger('click');
    expect(w.find('[data-test="confirm-discard"]').exists()).toBe(true);
    await w.find('[data-test="confirm-discard"]').trigger('click');
    await flushPromises();
    expect(deletions).toHaveLength(1);
    expect(w.find('[data-test="confirm-discard"]').exists()).toBe(false);
    expect(w.find('[data-test="cancel-discard"]').exists()).toBe(false);
    expect(w.find('[data-test="discard-draft"]').attributes('disabled')).toBeDefined();

    deleteAck.resolve();
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
    expect(await fake.listDrafts()).toEqual([]);
  });

  it('warns before browser unload when the active buffer is dirty and tears down both subscriptions', async () => {
    const fake = createBrowserFakeMailClient();
    const w = wrapper = await mountDraftsUi(fake);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('unsaved preview text');
    const event = new Event('beforeunload', { bubbles: false, cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await flushPromises();
    expect(fake.controls.listenerCount()).toBe(1);
    expect(fake.controls.draftListenerCount()).toBe(1);
    expect(fake.controls.closeListenerCount()).toBe(1);
    w.unmount();
    wrapper = null;
    await flushPromises();
    expect(fake.controls.listenerCount()).toBe(0);
    expect(fake.controls.draftListenerCount()).toBe(0);
    expect(fake.controls.closeListenerCount()).toBe(0);
  });

  it('blocks mailbox shortcuts while composing and has no send or submit path', async () => {
    const fake = createBrowserFakeMailClient();
    const w = wrapper = await mountDraftsUi(fake);
    await startNewDraft(w);
    await w.find('[data-test="draft-body"]').setValue('e j Enter remain text');
    const textarea = w.find('[data-test="draft-body"]').element;
    for (const key of ['e', 'j', 'Enter']) textarea.dispatchEvent(createKeyEvent(key, { bubbles: true }));
    window.dispatchEvent(createKeyEvent('e', { bubbles: true }));
    window.dispatchEvent(createKeyEvent('j', { bubbles: true }));
    window.dispatchEvent(createKeyEvent('Enter', { bubbles: true }));
    window.dispatchEvent(createKeyEvent('Enter', { bubbles: true, ctrlKey: true }));
    await flushPromises();
    expect(fake.controls.activity()).toEqual([]);
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('e j Enter remain text');
    expect(w.find('form').exists()).toBe(false);
    expect(w.findAll('button').every((button) => !/send/i.test(button.text()))).toBe(true);
    // Escape is the editor's, not the mailbox's and not the drawer's: it closes
    // through the protected flush, saves the exact text and returns to the list.
    window.dispatchEvent(createKeyEvent('Escape', { bubbles: true }));
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(false);
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-list-view"]').exists()).toBe(true);
    expect(fake.controls.activity()).toEqual([]);
    expect((await fake.getDraft((await fake.listDrafts())[0]!.ref)).content.bodyText).toBe('e j Enter remain text');
    // A second Escape closes the drawer.
    window.dispatchEvent(createKeyEvent('Escape', { bubbles: true }));
    await flushPromises();
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
  });

});
