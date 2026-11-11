/**
 * TASK B: the inline reply composer docked at the bottom of the OPEN reader.
 *
 * Reply keeps the reader open (the thread stays visible) and docks the
 * plain-text draft composer at the bottom of the reader pane instead of closing
 * the reader and opening the drafts drawer. The composer shows a "Draft to
 * {sender}" label and a READ-ONLY quoted snippet of the latest message; the
 * saved reply bodyText stays blank (frozen slice-04 contract: the quoted block
 * is never inserted into bodyText). No Send path exists. Escape/close and any
 * reader/drawer/search transition flush through the same protected draft
 * lifecycle as the drafts drawer; a failed close keeps the reader and the
 * composer visible with their unacknowledged buffer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

import ReplyComposer from '../src/components/ReplyComposer.vue';
import type { DraftContent, DraftReceipt, DraftSource, MailClient } from '../src/lib/ipc/client';
import { createBrowserFakeMailClient, deferred, fixtureRef, mountApp as sharedMountApp, press } from './helpers';
import { advanceUiUntil, useUiTestClock } from './support/timers';

describe('inline reply composer docked in the open reader (TASK B)', () => {
  let wrapper: VueWrapper | null = null;
  beforeEach(useUiTestClock);

  /** Opens conv-01 in the reader and clicks Reply. */
  async function openReaderAndPrepareReply(w: VueWrapper): Promise<void> {
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="prepare-reply"]').trigger('click');
    await flushPromises();
    await advanceUiUntil(() => w.find('[data-test="reply-composer"]').exists());
    await flushPromises();
  }

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.useRealTimers();
  });

  it('keeps the reader open and docks the composer at the bottom of the reader pane on Reply', async () => {
    const fake = createBrowserFakeMailClient();
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
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
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReaderAndPrepareReply(w);

    // One compact heading line: no separate "Draft" flag (the status line says "not sent").
    expect(w.find('[data-test="draft-flag"]').exists()).toBe(false);
    // Latest message of the open conversation: from.displayName ?? mailbox.
    expect(w.find('[data-test="draft-recipient-label"]').text()).toBe('Ada Fixture');
    expect(w.find('[data-test="reply-composer"] .composer-heading h2').text()).toContain('to Ada Fixture');
    // Compact layout: a one-line recipient row (name while To is the default sender),
    // Cc and Subject behind the toggle, and the body focused.
    expect(w.find('[data-test="draft-to-row"]').text()).toBe('Ada Fixture <ada@example.test>');
    expect(w.find('[data-test="draft-to"]').exists()).toBe(false);
    expect(w.find('[data-test="draft-cc"]').exists()).toBe(false);
    expect(w.find('[data-test="draft-subject"]').exists()).toBe(false);
    expect(document.activeElement).toBe(w.find('[data-test="draft-body"]').element);
    const toggle = w.find('[data-test="draft-fields-toggle"]');
    expect(toggle.text()).toBe('Cc / Subject');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    await w.find('[data-test="draft-to-row"]').trigger('click');
    await flushPromises();
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
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
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
    await vi.advanceTimersByTimeAsync(300);
    await flushPromises();
    const saved = await fake.getDraft((await fake.listDrafts())[0]!.ref);
    expect(saved.content.bodyText).toBe('my own reply text');
    expect(saved.content.bodyText).not.toContain(latest.bodyText);
    expect(w.find('[data-test="reply-quoted-context"]').text()).toBe(latest.bodyText);
  });

  it('quotes only the prose of the latest message, cut on a character boundary, and still never saves it', async () => {
    const fake = createBrowserFakeMailClient();
    const prose = `${'a'.repeat(199)}\u{1F600}tail`;
    const withLatest = async (bodyText: string): Promise<MailClient> => ({
      ...fake,
      getConversation: async (ref) => {
        const conversation = await fake.getConversation(ref);
        const messages = conversation.messages.map((m, i, all) => (i === all.length - 1 ? { ...m, bodyText } : m));
        return { ...conversation, messages };
      },
    });

    // A trailing localized quote is left out of the preview.
    let w = sharedMountApp(await withLatest('Merci, c’est bon.\n\nLe jeudi 6 nov. 2026, Ada a écrit :\n> Peut-on livrer ?\n> Vendredi.'), 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReaderAndPrepareReply(w);
    expect(w.find('[data-test="reply-quoted-context"]').text()).toBe('Merci, c’est bon.');
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('');
    w.unmount();
    wrapper = null;

    // The 200-unit cap never leaves half of an emoji.
    w = sharedMountApp(await withLatest(prose), 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReaderAndPrepareReply(w);
    const text = w.find('[data-test="reply-quoted-context"]').text();
    expect(text).toBe(`${'a'.repeat(199)}…`);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
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
    const w = sharedMountApp(client, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReaderAndPrepareReply(w);
    await w.find('[data-test="draft-body"]').setValue('last keystroke');

    press('Escape', { bubbles: true }, window);
    await flushPromises();
    // The flush is in flight: the composer must stay open.
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(true);
    gate.reject({ kind: 'storage_unavailable' });
    await flushPromises();
    await advanceUiUntil(() => w.find('[data-test="draft-error"]').exists());
    // Failed close: reader AND composer stay visible with the exact buffer.
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('last keystroke');

    // Retry the save, then Escape closes the composer through the protected
    // flush; the reader itself stays open.
    await w.find('[data-test="retry-draft-save"]').trigger('click');
    await flushPromises();
    press('Escape', { bubbles: true }, window);
    await flushPromises();
    await advanceUiUntil(() => !w.find('[data-test="reply-composer"]').exists());
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    const saved = await fake.getDraft((await fake.listDrafts())[0]!.ref);
    expect(saved.content.bodyText).toBe('last keystroke');
  });

  it('closes the inline composer through the Save and close control and keeps the reader open', async () => {
    const fake = createBrowserFakeMailClient();
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReaderAndPrepareReply(w);
    await w.find('[data-test="draft-body"]').setValue('typed reply');
    await w.find('[data-test="reply-composer"]').find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await advanceUiUntil(() => !w.find('[data-test="reply-composer"]').exists());
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
    const w = sharedMountApp(client, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReaderAndPrepareReply(w);
    await w.find('[data-test="draft-body"]').setValue('unacknowledged buffer');

    // Reader Back while the inline composer is open: protected flush first.
    await w.find('[data-test="reader-close"]').trigger('click');
    await flushPromises();
    await advanceUiUntil(() => w.find('[data-test="draft-error"]').exists());
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
    await advanceUiUntil(() => !w.find('[data-test="reader"]').exists());
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(false);
    const saved = await fake.getDraft((await fake.listDrafts())[0]!.ref);
    expect(saved.content.bodyText).toBe('unacknowledged buffer');
  });

  it('offers no Send path: the footer has only Save and close and Discard… (the Esc hint is not a button)', async () => {
    const fake = createBrowserFakeMailClient();
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReaderAndPrepareReply(w);
    const composer = w.find('[data-test="reply-composer"]');
    expect(composer.findAll('button').every((button) => !/send/i.test(button.text()))).toBe(true);
    expect(composer.find('form').exists()).toBe(false);
    const footer = composer.find('.composer-footer');
    expect(footer.exists()).toBe(true);
    expect(footer.findAll('button').map((button) => button.text())).toEqual(['Save and close', 'Discard…']);
    expect(footer.get('kbd').text()).toBe('Esc');
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
    const w = sharedMountApp(client, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReaderAndPrepareReply(w);
    await w.find('[data-test="draft-body"]').setValue('e j k stay text');

    for (const key of ['e', 'j', 'k', 'Enter', 'x', 'g', 'E']) press(key, { bubbles: true, ...(key === 'E' ? { shiftKey: true } : {}) }, window);
    await flushPromises();

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

  it('moves into the inline compose card when the reader moves off the reply source (contact recent row)', async () => {
    const fake = createBrowserFakeMailClient();
    const w = sharedMountApp(fake, 'browser-preview', { attachTo: document.body }); wrapper = w; await flushPromises();
    await openReaderAndPrepareReply(w);
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(true);
    // Click a different conversation in the contact pane's "Recent cached mail"
    // (the first row is the currently open thread).
    const other = w.findAll('.contact-recent button').find((b) => /thread 2/.test(b.text()));
    expect(other).toBeDefined();
    await other!.trigger('click');
    await flushPromises();
    await advanceUiUntil(() => !w.find('[data-test="reply-composer"]').exists());
    // The editor is still visible and protected: the same draft in the inline
    // card, titled as the reply draft, with the reason it is not in its thread.
    expect(w.find('[data-test="compose-card"]').exists()).toBe(true);
    expect(w.get('[data-test="compose-card"]').attributes('aria-label')).toBe('Reply draft to ada@example.test');
    expect(w.get('[data-test="compose-card-notice"]').text()).toBe('Source conversation not open. Editing locally; nothing is sent.');
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    expect((await fake.listDrafts())).toHaveLength(1);
    expect((await fake.listDrafts())[0]?.source).toMatchObject({ kind: 'reply' });
  });

  describe('compact recipient row and on-demand fields', () => {
    const source: DraftSource = { kind: 'reply', conversation: fixtureRef('conv-01'), sourceMessageId: 'conv-01-m3' };
    const props = (content: Partial<DraftContent> = {}) => ({
      recipientLabel: 'Ada Fixture',
      recipientMailbox: 'ada@example.test',
      quotedSnippet: 'Ship it > <b>Friday</b>\nsecond line',
      activeRef: { accountId: 'fixture', draftId: 'd1' },
      source,
      content: { to: 'ada@example.test', cc: '', subject: 'Re: x', bodyText: '', ...content },
      status: 'Saved locally',
      visible: true,
      creating: false,
      saving: false,
      conflict: false,
      error: null,
      createError: null,
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
    });

    it('shows the display name only while To is the default sender, and an input on activation', async () => {
      const w = mount(ReplyComposer, { props: props(), attachTo: document.body });
      wrapper = w as unknown as VueWrapper;
      const row = w.get('[data-test="draft-to-row"]');
      expect(row.element.tagName).toBe('BUTTON');
      expect(row.text()).toBe('Ada Fixture <ada@example.test>');
      expect(w.find('[data-test="draft-to"]').exists()).toBe(false);
      await row.trigger('click');
      await flushPromises();
      const input = w.get('[data-test="draft-to"]');
      expect((input.element as HTMLInputElement).value).toBe('ada@example.test');
      expect(document.activeElement).toBe(input.element);
      await input.setValue('someone-else@example.test');
      expect(w.emitted('setField')).toEqual([['to', 'someone-else@example.test']]);
    });

    it('shows the real address next to a display name that differs from it (no hover-only address)', () => {
      const w = mount(ReplyComposer, {
        props: { ...props({ to: 'x@evil.test' }), recipientLabel: 'Bank Support', recipientMailbox: 'x@evil.test' },
      });
      wrapper = w as unknown as VueWrapper;
      const row = w.get('[data-test="draft-to-row"]');
      expect(row.text()).toContain('Bank Support');
      expect(row.text()).toContain('<x@evil.test>');
      expect(row.get('[data-test="draft-to-address"]').text()).toBe('<x@evil.test>');
      // Interpolated text, never markup.
      expect(row.find('b, a, img').exists()).toBe(false);
    });

    it('shows the address once when there is no distinct display name, and for a still-created reply', () => {
      const bare = mount(ReplyComposer, {
        props: { ...props({ to: 'ada@example.test' }), recipientLabel: 'ada@example.test', recipientMailbox: 'ada@example.test' },
      });
      expect(bare.get('[data-test="draft-to-row"]').text()).toBe('ada@example.test');
      bare.unmount();
      const creating = mount(ReplyComposer, { props: { ...props({ to: '' }), activeRef: null, creating: true, status: 'Creating local draft…' } });
      wrapper = creating as unknown as VueWrapper;
      expect(creating.get('[data-test="draft-to-row"]').text()).toBe('Ada Fixture <ada@example.test>');
    });

    it('never misrepresents an edited To: the raw text is shown verbatim in the input, and Cc and Subject stay closed', () => {
      const w = mount(ReplyComposer, { props: props({ to: '  Ada, bob@example.test ' }) });
      wrapper = w as unknown as VueWrapper;
      expect(w.find('[data-test="draft-to-row"]').exists()).toBe(false);
      expect((w.get('[data-test="draft-to"]').element as HTMLInputElement).value).toBe('  Ada, bob@example.test ');
      // The To row is already a visible input, so nothing is hidden by keeping the extras closed.
      expect(w.find('[data-test="draft-cc"]').exists()).toBe(false);
      expect(w.find('[data-test="draft-subject"]').exists()).toBe(false);
      const toggle = w.get('[data-test="draft-fields-toggle"]');
      expect(toggle.attributes('aria-expanded')).toBe('false');
      expect(toggle.attributes('disabled')).toBeUndefined();
    });

    it.each([
      ['a saved Cc', { cc: 'cc@example.test' }],
      ['a subject that is not the default Re: line', { subject: 'Different topic' }],
    ])('keeps %s visible instead of hiding data', (_name, content) => {
      const w = mount(ReplyComposer, { props: props(content) });
      wrapper = w as unknown as VueWrapper;
      expect(w.get('[data-test="draft-fields-toggle"]').attributes('aria-expanded')).toBe('true');
      expect(w.find('[data-test="draft-cc"]').exists()).toBe(true);
      expect(w.find('[data-test="draft-subject"]').exists()).toBe(true);
    });

    it('reveals Cc and Subject on demand, moves focus into Cc, and hides them again when collapsed', async () => {
      const w = mount(ReplyComposer, { props: props(), attachTo: document.body });
      wrapper = w as unknown as VueWrapper;
      const toggle = w.get('[data-test="draft-fields-toggle"]');
      expect(w.find('[data-test="draft-cc"]').exists()).toBe(false);
      await toggle.trigger('click');
      await flushPromises();
      expect(toggle.attributes('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(w.get('[data-test="draft-cc"]').element);
      expect((w.get('[data-test="draft-subject"]').element as HTMLInputElement).value).toBe('Re: x');
      await toggle.trigger('click');
      expect(w.find('[data-test="draft-cc"]').exists()).toBe(false);
      expect(w.find('[data-test="draft-subject"]').exists()).toBe(false);
    });

    it('shows the quoted block read-only as literal text and exposes the fixed source only as attributes', () => {
      const w = mount(ReplyComposer, { props: props() });
      wrapper = w as unknown as VueWrapper;
      const quoted = w.get('[data-test="reply-quoted-context"]');
      expect(quoted.attributes('aria-label')).toBe('Quoted latest message (read-only)');
      expect(quoted.text()).toBe('Ship it > <b>Friday</b>\nsecond line');
      expect(quoted.find('b').exists()).toBe(false);
      const sourceEl = w.get('[data-test="reply-source"]');
      expect(sourceEl.attributes('data-source-conversation')).toBe('conv-01');
      expect(sourceEl.attributes('data-source-message')).toBe('conv-01-m3');
      expect(w.text()).not.toContain('conv-01');
    });

    it('stays disabled and shows the name while the reply is still being created', () => {
      const w = mount(ReplyComposer, { props: { ...props({ to: '' }), activeRef: null, creating: true, status: 'Creating local draft…' } });
      wrapper = w as unknown as VueWrapper;
      expect(w.get('[data-test="draft-to-row"]').text()).toBe('Ada Fixture <ada@example.test>');
      expect(w.get('[data-test="draft-to-row"]').attributes('disabled')).toBeDefined();
      expect(w.get('[data-test="draft-body"]').attributes('disabled')).toBeDefined();
    });
  });

  describe('heading follows the actual To', () => {
    const source: DraftSource = { kind: 'reply', conversation: fixtureRef('conv-01'), sourceMessageId: 'conv-01-m3' };
    const props = (content: Partial<DraftContent> = {}, extra: Record<string, unknown> = {}) => ({
      recipientLabel: 'Ada Fixture',
      recipientMailbox: 'ada@example.test',
      quotedSnippet: 'quoted',
      activeRef: { accountId: 'fixture', draftId: 'd1' },
      source,
      content: { to: 'ada@example.test', cc: '', subject: 'Re: x', bodyText: '', ...content },
      status: 'Saved locally',
      visible: true,
      creating: false,
      saving: false,
      conflict: false,
      error: null,
      createError: null,
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
      ...extra,
    });
    const heading = (w: ReturnType<typeof mount>) => w.get('.composer-heading h2');
    const label = (w: ReturnType<typeof mount>) => w.find('[data-test="draft-recipient-label"]');

    it('names the sender by display name while To is the default mailbox, in any letter case', () => {
      const w = mount(ReplyComposer, { props: props() });
      wrapper = w as unknown as VueWrapper;
      expect(heading(w).text()).toBe('Reply draft to Ada Fixture');
      expect(label(w).text()).toBe('Ada Fixture');
      w.unmount();
      const upper = mount(ReplyComposer, { props: props({ to: ' ADA@Example.test ' }) });
      wrapper = upper as unknown as VueWrapper;
      expect(heading(upper).text()).toBe('Reply draft to Ada Fixture');
    });

    it('keeps the name while the draft is still being created and To is empty', () => {
      const w = mount(ReplyComposer, { props: props({ to: '' }, { activeRef: null, creating: true, status: 'Creating local draft…' }) });
      wrapper = w as unknown as VueWrapper;
      expect(heading(w).text()).toBe('Reply draft to Ada Fixture');
    });

    it('names the Reply-To address when it differs from the sender; To is the raw input and the extras stay closed', () => {
      const w = mount(ReplyComposer, { props: props({ to: 'list@lists.example' }) });
      wrapper = w as unknown as VueWrapper;
      expect(heading(w).text()).toBe('Reply draft to list@lists.example');
      expect(label(w).text()).toBe('list@lists.example');
      expect(w.get('.reply-to').attributes('title')).toBe('list@lists.example');
      expect((w.get('[data-test="draft-to"]').element as HTMLInputElement).value).toBe('list@lists.example');
      expect(w.find('[data-test="draft-to-row"]').exists()).toBe(false);
      expect(w.find('[data-test="draft-cc"]').exists()).toBe(false);
      expect(w.find('[data-test="draft-subject"]').exists()).toBe(false);
      const toggle = w.get('[data-test="draft-fields-toggle"]');
      expect(toggle.text()).toBe('Cc / Subject');
      expect(toggle.attributes('aria-expanded')).toBe('false');
      expect(toggle.attributes('disabled')).toBeUndefined();
    });

    it('shows the first recipient and a count for several, with the full To in the title', () => {
      const to = 'list@lists.example, Bob <bob@example.test>;  carol@example.test';
      const w = mount(ReplyComposer, { props: props({ to }) });
      wrapper = w as unknown as VueWrapper;
      expect(heading(w).text()).toBe('Reply draft to list@lists.example +2');
      expect(w.get('.reply-to').attributes('title')).toBe(to);
      expect((w.get('[data-test="draft-to"]').element as HTMLInputElement).value).toBe(to);
    });

    it('skips empty entries and follows an edit of To without opening Cc or Subject', async () => {
      const w = mount(ReplyComposer, { props: props(), attachTo: document.body });
      wrapper = w as unknown as VueWrapper;
      await w.get('[data-test="draft-to-row"]').trigger('click');
      await flushPromises();
      await w.get('[data-test="draft-to"]').setValue('x@example.test');
      expect(w.emitted('setField')).toEqual([['to', 'x@example.test']]);
      // The parent owns content; mirror the emitted edit as props.
      await w.setProps({ content: { to: ' , ;x@example.test', cc: '', subject: 'Re: x', bodyText: '' } });
      expect(heading(w).text()).toBe('Reply draft to x@example.test');
      await w.setProps({ content: { to: 'x@example.test, y@example.test', cc: '', subject: 'Re: x', bodyText: '' } });
      expect(heading(w).text()).toBe('Reply draft to x@example.test +1');
      expect(w.find('[data-test="draft-cc"]').exists()).toBe(false);
      expect(w.find('[data-test="draft-subject"]').exists()).toBe(false);
      expect(w.get('[data-test="draft-fields-toggle"]').attributes('aria-expanded')).toBe('false');
    });

    it.each(['', '   ', ' , ; '])('drops the recipient from the heading when a ready draft has To %j', (to) => {
      const w = mount(ReplyComposer, { props: props({ to }) });
      wrapper = w as unknown as VueWrapper;
      expect(heading(w).text()).toBe('Reply draft');
      expect(label(w).exists()).toBe(false);
    });

    it('keeps the heading on one short line for 20 Reply-To addresses and the input holds all of them', () => {
      const to = Array.from({ length: 20 }, (_, i) => `member${i + 1}@lists.example`).join(', ');
      const w = mount(ReplyComposer, { props: props({ to }) });
      wrapper = w as unknown as VueWrapper;
      expect(heading(w).text()).toBe('Reply draft to member1@lists.example +19');
      expect(heading(w).text()).not.toContain('\n');
      expect(w.get('.reply-to').attributes('title')).toBe(to);
      expect((w.get('[data-test="draft-to"]').element as HTMLInputElement).value).toBe(to);
    });

    it('still keeps a saved Cc or a custom subject visible with a custom To', () => {
      const w = mount(ReplyComposer, { props: props({ to: 'list@lists.example', cc: 'cc@example.test' }) });
      wrapper = w as unknown as VueWrapper;
      expect(w.find('[data-test="draft-cc"]').exists()).toBe(true);
      expect(w.get('[data-test="draft-fields-toggle"]').attributes('aria-expanded')).toBe('true');
    });
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
