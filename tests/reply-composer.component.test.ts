/**
 * TASK B: the inline reply composer docked at the bottom of the OPEN reader.
 *
 * Prepare reply keeps the reader open (the thread stays visible) and docks the
 * plain-text draft composer at the bottom of the reader pane instead of closing
 * the reader and opening the drafts drawer. The composer shows a "Draft to
 * {sender}" label and a READ-ONLY quoted snippet of the latest message; the
 * saved reply bodyText stays blank (frozen slice-04 contract: the quoted block
 * is never inserted into bodyText). No Send path exists. Escape/close and any
 * reader/drawer/search transition flush through the same protected draft
 * lifecycle as the drafts drawer; a failed close keeps the reader and the
 * composer visible with their unacknowledged buffer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import ReplyComposer from '../src/components/ReplyComposer.vue';
import type { DraftReceipt, DraftSource, MailClient } from '../src/lib/ipc/client';
import {
  createBrowserFakeMailClient,
  deferred,
  fixtureRef,
  waitFor,
  type BrowserFake,
} from './helpers';

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, ...init });
}

describe('inline reply composer docked in the open reader (TASK B)', () => {
  let wrapper: VueWrapper | null = null;

  async function mountApp(fake: BrowserFake, client: MailClient = fake): Promise<VueWrapper> {
    const mounted = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = mounted;
    await flushPromises();
    return mounted;
  }

  /** Opens conv-01 in the reader and clicks Prepare reply. */
  async function openReaderAndPrepareReply(w: VueWrapper): Promise<void> {
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="prepare-reply"]').trigger('click');
    await flushPromises();
    await waitFor(() => w.find('[data-test="reply-composer"]').exists());
    await flushPromises();
  }

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('keeps the reader open and docks the composer at the bottom of the reader pane on Prepare reply', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await openReaderAndPrepareReply(w);

    // The reader stays open; the thread is still visible above the composer.
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect(w.find('[data-test="reader-messages"]').exists()).toBe(true);
    const pane = w.find('section.reader-pane');
    expect(pane.exists()).toBe(true);
    const composer = pane.find('[data-test="reply-composer"]');
    expect(composer.exists()).toBe(true);
    // Docked at the BOTTOM of the reader pane: the composer is the pane's last child.
    expect(pane.element.lastElementChild?.getAttribute('data-test')).toBe('reply-composer');
    expect(pane.element.firstElementChild?.getAttribute('data-test')).toBe('reader');
    // The drafts drawer was NOT opened instead.
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(false);
    // The reply targets the displayed latest message.
    const draft = (await fake.listDrafts())[0]!;
    expect(draft.source).toEqual({ kind: 'reply', conversation: fixtureRef('conv-01'), sourceMessageId: 'conv-01-m3' });
  });

  it('shows the "Draft to {sender}" label and the prefilled reply fields with a blank body', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await openReaderAndPrepareReply(w);

    expect(w.find('[data-test="draft-flag"]').text()).toBe('Draft');
    // Latest message of the open conversation: from.displayName ?? mailbox.
    expect(w.find('[data-test="draft-recipient-label"]').text()).toBe('Ada Fixture');
    expect(w.find('[data-test="reply-composer"] .composer-heading h2').text()).toContain('to Ada Fixture');
    expect((w.find('[data-test="draft-to"]').element as HTMLInputElement).value).toBe('ada@example.test');
    expect((w.find('[data-test="draft-cc"]').element as HTMLInputElement).value).toBe('');
    expect((w.find('[data-test="draft-subject"]').element as HTMLInputElement).value).toBe('Re: Fixture thread 1: weekly status');
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('');
    // Frozen contract: one Re: prefix, empty Cc, and an EMPTY saved body.
    const saved = await fake.getDraft((await fake.listDrafts())[0]!.ref);
    expect(saved.content).toEqual({
      to: 'ada@example.test',
      cc: '',
      subject: 'Re: Fixture thread 1: weekly status',
      bodyText: '',
    });
  });

  it('renders the latest message as a read-only quoted snippet that never enters bodyText', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await openReaderAndPrepareReply(w);

    const quoted = w.find('[data-test="reply-quoted-context"]');
    expect(quoted.exists()).toBe(true);
    const el = quoted.element as HTMLElement;
    // Plain-text, read-only block: not an input, not editable, no v-html children.
    expect(el.tagName).toBe('BLOCKQUOTE');
    expect(el.getAttribute('contenteditable')).toBeNull();
    expect(quoted.find('input, textarea, [contenteditable]').exists()).toBe(false);
    const latest = (await fake.getConversation(fixtureRef('conv-01'))).messages.at(-1)!;
    expect(quoted.text()).toBe(latest.bodyText);
    expect(quoted.element.querySelector('script, img, a')).toBeNull();
    // The saved reply body stays empty even though the quote is visible.
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('');
    expect((await fake.getDraft((await fake.listDrafts())[0]!.ref)).content.bodyText).toBe('');

    // Editing the body saves only the typed text; the quote is never appended.
    await w.find('[data-test="draft-body"]').setValue('my own reply text');
    await new Promise((resolve) => setTimeout(resolve, 360));
    await flushPromises();
    const saved = await fake.getDraft((await fake.listDrafts())[0]!.ref);
    expect(saved.content.bodyText).toBe('my own reply text');
    expect(saved.content.bodyText).not.toContain(latest.bodyText);
    expect(w.find('[data-test="reply-quoted-context"]').text()).toBe(latest.bodyText);
  });

  it('flushes through the protected path on Escape: a failed close keeps reader+composer, success hides only the composer', async () => {
    const fake = createBrowserFakeMailClient();
    const gate = deferred<DraftReceipt>();
    let saves = 0;
    const client: MailClient = {
      ...fake,
      saveDraft: (command) => {
        saves += 1;
        return saves === 1 ? gate.promise : fake.saveDraft(command);
      },
    };
    const w = await mountApp(fake, client);
    await openReaderAndPrepareReply(w);
    await w.find('[data-test="draft-body"]').setValue('last keystroke');

    window.dispatchEvent(keydown('Escape'));
    await flushPromises();
    // The flush is in flight: the composer must stay open.
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(true);
    gate.reject({ kind: 'storage_unavailable' });
    await flushPromises();
    await waitFor(() => w.find('[data-test="draft-error"]').exists());
    // Failed close: reader AND composer stay visible with the exact buffer.
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('last keystroke');

    // Retry the save, then Escape closes the composer through the protected
    // flush; the reader itself stays open.
    await w.find('[data-test="retry-draft-save"]').trigger('click');
    await flushPromises();
    window.dispatchEvent(keydown('Escape'));
    await flushPromises();
    await waitFor(() => !w.find('[data-test="reply-composer"]').exists());
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    const saved = await fake.getDraft((await fake.listDrafts())[0]!.ref);
    expect(saved.content.bodyText).toBe('last keystroke');
  });

  it('closes the inline composer through the Close editor control and keeps the reader open', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await openReaderAndPrepareReply(w);
    await w.find('[data-test="draft-body"]').setValue('typed reply');
    await w.find('[data-test="reply-composer"]').find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await waitFor(() => !w.find('[data-test="reply-composer"]').exists());
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    const saved = await fake.getDraft((await fake.listDrafts())[0]!.ref);
    expect(saved.content.bodyText).toBe('typed reply');
  });

  it('routes closing the reader and switching drawers through the protected flush (failed close keeps reader+composer)', async () => {
    const fake = createBrowserFakeMailClient();
    let failSaves = true;
    const client: MailClient = {
      ...fake,
      saveDraft: (command) => (failSaves ? Promise.reject({ kind: 'storage_unavailable' }) : fake.saveDraft(command)),
    };
    const w = await mountApp(fake, client);
    await openReaderAndPrepareReply(w);
    await w.find('[data-test="draft-body"]').setValue('unacknowledged buffer');

    // Reader Back while the inline composer is open: protected flush first.
    await w.find('[data-test="reader-close"]').trigger('click');
    await flushPromises();
    await waitFor(() => w.find('[data-test="draft-error"]').exists());
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('unacknowledged buffer');

    // Switching to another drawer is blocked by the same failed flush.
    await w.find('[data-test="rail-activity"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(true);
    expect(w.find('[data-test="reader"]').exists()).toBe(true);

    // After the retry succeeds, Back closes the reader and releases the composer.
    failSaves = false;
    await w.find('[data-test="retry-draft-save"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="reader-close"]').trigger('click');
    await flushPromises();
    await waitFor(() => !w.find('[data-test="reader"]').exists());
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(false);
    const saved = await fake.getDraft((await fake.listDrafts())[0]!.ref);
    expect(saved.content.bodyText).toBe('unacknowledged buffer');
  });

  it('offers no Send path: the footer has only Close editor and Discard…', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await openReaderAndPrepareReply(w);
    const composer = w.find('[data-test="reply-composer"]');
    expect(composer.findAll('button').every((button) => !/send/i.test(button.text()))).toBe(true);
    expect(composer.find('form').exists()).toBe(false);
    const footer = composer.find('.composer-footer');
    expect(footer.exists()).toBe(true);
    expect(footer.findAll('button').map((button) => button.text())).toEqual(['Close editor', 'Discard…']);
    // The discard flow is the revision-checked confirm dialog, mirrored from the drawer.
    await composer.find('[data-test="discard-draft"]').trigger('click');
    await flushPromises();
    expect(composer.find('[data-test="confirm-discard"]').exists()).toBe(true);
    await composer.find('[data-test="cancel-discard"]').trigger('click');
    await flushPromises();
    expect(composer.find('[data-test="confirm-discard"]').exists()).toBe(false);
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(true);
  });

  it('suppresses mailbox shortcuts (e.g. e) while the inline composer is open', async () => {
    const fake = createBrowserFakeMailClient();
    let archives = 0;
    const client: MailClient = {
      ...fake,
      setArchived: (command) => {
        archives += 1;
        return fake.setArchived(command);
      },
    };
    const w = await mountApp(fake, client);
    await openReaderAndPrepareReply(w);
    await w.find('[data-test="draft-body"]').setValue('e j k stay text');

    for (const key of ['e', 'j', 'k', 'Enter', 'x', 'g', 'E']) window.dispatchEvent(keydown(key, key === 'E' ? { shiftKey: true } : {}));
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(archives).toBe(0);
    expect(fake.controls.activity()).toEqual([]);
    // The buffer kept every key as text.
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('e j k stay text');
    // The reader is still on conv-01 (j/k did not move the reader cursor).
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect(w.find('.reader-subject').text()).toBe('Fixture thread 1: weekly status');
    // Search entry is refused while the composer owns the keys.
    expect(w.find('[data-test="search-input"]').exists()).toBe(false);
  });

  it('re-docks into the drafts drawer when the reader moves off the reply source (contact recent row)', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await openReaderAndPrepareReply(w);
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(true);
    // Click a different conversation in the contact pane's "Recent cached mail"
    // (the first row is the currently open thread).
    const other = w.findAll('.contact-recent button').find((b) => /thread 2/.test(b.text()));
    expect(other).toBeDefined();
    await other!.trigger('click');
    await flushPromises();
    await waitFor(() => !w.find('[data-test="reply-composer"]').exists());
    // The editor is still visible and protected: docked in the drafts drawer.
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(true);
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    expect((await fake.listDrafts())).toHaveLength(1);
    expect((await fake.listDrafts())[0]?.source).toMatchObject({ kind: 'reply' });
  });

  it('offers conflict recovery (reload / save as new) on the docked reply composer', async () => {
    const source: DraftSource = { kind: 'reply', conversation: fixtureRef('conv-01'), sourceMessageId: 'conv-01-m3' };
    const base = {
      recipientLabel: 'Ada Fixture',
      quotedSnippet: 'quoted…',
      activeRef: { accountId: 'fixture', draftId: 'd1' },
      source,
      content: { to: 'ada@example.test', cc: '', subject: 'Re: x', bodyText: 'my text' },
      status: '',
      visible: true,
      creating: false,
      saving: false,
      deleting: false,
      closing: false,
      transitioning: false,
      deletePending: false,
      confirmDiscard: false,
      discardBusy: false,
      confirmReload: false,
      copyPending: false,
      recoveryRequired: false,
      canCancelReplyPreparation: false,
      closeError: null,
      conflict: true,
      error: { kind: 'draft_conflict', currentRevision: 2 } as const,
      createError: null,
    };
    const w = mount(ReplyComposer, { props: base });
    wrapper = w as unknown as VueWrapper;
    // The full conflict/recovery block renders on the docked surface too.
    const actions = w.get('[data-test="draft-conflict-actions"]');
    expect(actions.find('[data-test="ask-reload"]').exists()).toBe(true);
    expect(actions.find('[data-test="save-as-new"]').exists()).toBe(true);
    await actions.find('[data-test="ask-reload"]').trigger('click');
    expect(w.emitted('askReload')).toHaveLength(1);
    await w.setProps({ confirmReload: true });
    await w.find('[data-test="confirm-reload"]').trigger('click');
    expect(w.emitted('confirmReload')).toHaveLength(1);
    await w.find('[data-test="cancel-reload"]').trigger('click');
    expect(w.emitted('cancelReload')).toHaveLength(1);
    await w.find('[data-test="save-as-new"]').trigger('click');
    expect(w.emitted('saveAsNew')).toHaveLength(1);
    // closeError is displayed on the docked surface as well.
    await w.setProps({ conflict: false, error: null, closeError: 'close failed' });
    expect(w.get('[data-test="draft-close-error"]').text()).toBe('close failed');
  });
});
