import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import ComposeCard from '../src/components/ComposeCard.vue';
import { browsingActions } from '../src/lib/browsing-actions';
import { REPLY_REASONS, sourceLoadErrorReason } from '../src/lib/reply-context';
import { actionAliases, actionGroupOf, matchesQuery } from '../src/lib/action-palette';
import { createBrowserFakeMailClient, deferred, waitFor, type BrowserFake } from './helpers';
import type { DraftContent, DraftReceipt, MailClient } from '../src/lib/ipc/client';

function keydown(key: string, init: KeyboardEventInit & { keyCode?: number } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  return event;
}

type CardProps = InstanceType<typeof ComposeCard>['$props'];

const EMPTY_CONTENT: DraftContent = { to: '', cc: '', subject: '', bodyText: '' };

function cardProps(overrides: Partial<CardProps> = {}): CardProps {
  return {
    activeRef: { accountId: 'fixture-account', draftId: 'draft-0001' },
    source: { kind: 'new_message' },
    content: { ...EMPTY_CONTENT },
    status: '',
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
    ...overrides,
  };
}

describe('ComposeCard inline new-message card', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  it('renders as an in-flow card (no backdrop, no modal role) with To/Cc/Subject/Body fields and emits setField and close', async () => {
    wrapper = mount(ComposeCard, { props: cardProps() });
    const card = wrapper.get('[data-test="compose-card"]');
    // Inline card, not a modal dialog: the card IS the component root and there
    // is no backdrop element and no dialog/aria-modal semantics.
    expect(wrapper.element).toBe(card.element);
    expect(card.attributes('role')).toBeUndefined();
    expect(card.attributes('aria-modal')).toBeUndefined();
    expect(card.attributes('aria-label')).toBe('New Message');
    expect(wrapper.find('[data-test="compose-backdrop"]').exists()).toBe(false);
    expect(wrapper.find('.compose-backdrop').exists()).toBe(false);
    expect(wrapper.get('.composer-heading h2').text()).toBe('New Message');
    // To and Subject stay visible as one-line rows; Cc is on demand.
    for (const hook of ['draft-to', 'draft-subject', 'draft-body']) {
      expect(wrapper.find(`[data-test="${hook}"]`).exists()).toBe(true);
    }
    expect(wrapper.find('[data-test="draft-cc"]').exists()).toBe(false);
    const toggle = wrapper.get('[data-test="draft-fields-toggle"]');
    expect(toggle.text()).toBe('Cc');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await wrapper.get('[data-test="draft-to"]').setValue('ada@example.test');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('true');
    expect(wrapper.find('[data-test="draft-cc"]').exists()).toBe(true);
    await wrapper.get('[data-test="draft-cc"]').setValue('cc@example.test');
    await wrapper.get('[data-test="draft-subject"]').setValue('Hello <b>not markup</b>');
    await wrapper.get('[data-test="draft-body"]').setValue('Body text ✓');
    expect(wrapper.emitted('setField')).toEqual([
      ['to', 'ada@example.test'],
      ['cc', 'cc@example.test'],
      ['subject', 'Hello <b>not markup</b>'],
      ['bodyText', 'Body text ✓'],
    ]);
    // User text stays plain text: no element injects the markup as HTML.
    expect(wrapper.find('[data-test="draft-subject"]').element.innerHTML).not.toContain('<b>');
    await wrapper.get('[data-test="close-composer"]').trigger('click');
    expect(wrapper.emitted('closeEditor')).toHaveLength(1);
  });

  it('ships no backdrop or fixed-position overlay styles for the compose card', () => {
    // Vitest transforms import.meta.url to a non-file scheme; the config root
    // is the repo checkout, so read the stylesheet relative to the cwd.
    const css = readFileSync('src/assets/style.css', 'utf8');
    expect(css).not.toContain('.compose-backdrop');
    const start = css.indexOf('.compose-card {');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('}', start));
    expect(rule).not.toMatch(/position\s*:\s*fixed/);
    expect(rule).toContain('border: 1px solid var(--divider)');
    expect(rule).toContain('background: var(--surface-raised)');
  });

  it('offers only Save and close and Discard… in the footer, with an Esc hint that is not a button, and has no Send control', async () => {
    wrapper = mount(ComposeCard, { props: cardProps() });
    const footer = wrapper.get('.composer-footer');
    expect(footer.findAll('button').map((button) => button.text().trim())).toEqual(['Save and close', 'Discard…']);
    expect(footer.get('kbd').text()).toBe('Esc');
    expect(wrapper.findAll('button').every((button) => !/send/i.test(button.text()))).toBe(true);
    expect(wrapper.findAll('*').filter((el) => el.text().trim() === 'Send')).toHaveLength(0);
    expect(wrapper.find('form').exists()).toBe(false);
    await footer.get('[data-test="close-composer"]').trigger('click');
    await footer.get('[data-test="discard-draft"]').trigger('click');
    expect(wrapper.emitted('closeEditor')).toHaveLength(1);
    expect(wrapper.emitted('askDiscard')).toHaveLength(1);
  });

  it('states the local-only guarantee once, in one status line, with the detail in the title and a hidden description', async () => {
    wrapper = mount(ComposeCard, { props: cardProps() });
    // No permanent multi-line disclaimer.
    expect(wrapper.find('.draft-local-note').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('No Send action exists');
    const status = wrapper.get('[data-test="draft-status"]');
    expect(status.text()).toBe('Local draft · not sent');
    expect(status.classes()).toContain('draft-status-calm');
    const detail = 'Local plain-text draft. Nothing is sent. Recipients are stored as typed and are not validated. Bcc, reply-all and rich text are not supported.';
    expect(status.attributes('title')).toBe(detail);
    const hidden = wrapper.get('[data-test="draft-local-detail"]');
    expect(hidden.text()).toBe(detail);
    expect(hidden.classes()).toContain('visually-hidden');
    expect(wrapper.get('[data-test="draft-body"]').attributes('aria-describedby')).toBe(hidden.attributes('id'));
    // Never claims quoted text is unsupported.
    expect(wrapper.text()).not.toMatch(/quoted text/i);
  });

  it.each([
    ['Saved locally', 'Saved locally · not sent', true],
    ['Draft loaded from this device', 'Draft loaded from this device · not sent', true],
    ['Saved in preview memory (non-durable)', 'Saved in preview memory (non-durable) · not sent', false],
    ['Loaded from preview memory (non-durable)', 'Loaded from preview memory (non-durable) · not sent', false],
    ['Saving locally…', 'Saving locally…', false],
    ['Creating local draft…', 'Creating local draft…', false],
    ['Save not confirmed', 'Save not confirmed', false],
    ['Conflict — edits preserved', 'Conflict — edits preserved', false],
  ])('shows the %s status as "%s" (calm Ash: %s)', async (status, text, calm) => {
    wrapper = mount(ComposeCard, { props: cardProps({ status }) });
    const line = wrapper.get('[data-test="draft-status"]');
    expect(line.text()).toBe(text);
    expect(line.classes().includes('draft-status-calm')).toBe(calm);
  });

  it('keeps a saved Cc visible and its toggle expanded', async () => {
    wrapper = mount(ComposeCard, { props: cardProps({ content: { ...EMPTY_CONTENT, cc: 'cc@example.test' } }) });
    expect((wrapper.get('[data-test="draft-cc"]').element as HTMLInputElement).value).toBe('cc@example.test');
    expect(wrapper.get('[data-test="draft-fields-toggle"]').attributes('aria-expanded')).toBe('true');
  });

  it('ships a body of at least six lines and a docked shell that keeps the thread visible', () => {
    const css = readFileSync('src/assets/style.css', 'utf8');
    const textarea = css.slice(css.indexOf('.field-textarea {'), css.indexOf('}', css.indexOf('.field-textarea {')));
    expect(textarea).toMatch(/min-height:\s*7\.5rem/);
    const docked = css.slice(css.indexOf('.reader-pane > .compose-card {'), css.indexOf('}', css.indexOf('.reader-pane > .compose-card {')));
    expect(docked).toContain('max-height: 60%');
    expect(readFileSync('src/components/ReplyComposer.vue', 'utf8')).toContain('max-height: 60%');
  });

  it('shows the status line, alerts and the mirrored conflict/discard blocks with their emits', async () => {
    wrapper = mount(ComposeCard, {
      props: cardProps({
        status: 'Saved in preview memory (non-durable)',
        error: { kind: 'draft_conflict', currentRevision: 7 },
        conflict: true,
        confirmDiscard: true,
      }),
    });
    const status = wrapper.get('[data-test="draft-status"]');
    // One status line: the preview words stay, "not sent" is appended, and non-durable stays Amber.
    expect(status.text()).toBe('Saved in preview memory (non-durable) · not sent');
    // Not a live region itself: the hidden status region announces only meaningful transitions.
    expect(status.attributes('aria-live')).toBeUndefined();
    expect(wrapper.get('[data-test="draft-status-announce"]').text()).toBe('Saved in preview memory (non-durable) · not sent');
    expect(wrapper.get('[data-test="draft-error"]').text()).toContain('revision 7');
    expect(wrapper.find('[data-test="draft-conflict-actions"]').exists()).toBe(true);
    await wrapper.get('[data-test="save-as-new"]').trigger('click');
    await wrapper.get('[data-test="confirm-discard"]').trigger('click');
    await wrapper.get('[data-test="cancel-discard"]').trigger('click');
    expect(wrapper.emitted('saveAsNew')).toHaveLength(1);
    expect(wrapper.emitted('confirmDiscard')).toHaveLength(1);
    expect(wrapper.emitted('cancelDiscard')).toHaveLength(1);
  });

  it('renders the create-error alert like the drafts composer', () => {
    wrapper = mount(ComposeCard, { props: cardProps({ createError: { kind: 'storage_unavailable' } }) });
    expect(wrapper.get('[data-test="draft-create-error"]').text()).toContain('Retry is safe');
  });
});

describe('compose palette metadata', () => {
  it('registers compose in the conversation group with aliases and the C key', () => {
    const compose = browsingActions.find((action) => action.id === 'compose');
    expect(compose).toBeDefined();
    expect(compose?.label).toBe('Compose new local draft');
    expect(compose?.shortcut).toBe('C');
    expect(actionGroupOf.compose).toBe('conversation');
    expect(actionAliases.compose).toEqual(['new message', 'write', 'new draft', 'mail']);
    const keys = [compose?.shortcut ?? ''];
    const aliases = actionAliases.compose;
    const label = compose?.label ?? '';
    expect(matchesQuery('compose', label, aliases, keys)).toBe(true);
    expect(matchesQuery('c', label, aliases, keys)).toBe(true);
    expect(matchesQuery('new message', label, aliases, keys)).toBe(true);
    expect(matchesQuery('write', label, aliases, keys)).toBe(true);
    expect(matchesQuery('new draft', label, aliases, keys)).toBe(true);
    // No send path is discoverable through the palette metadata either.
    expect(matchesQuery('send', label, aliases, keys)).toBe(false);
  });
});

describe('compose entry points in App (inline card in the central pane)', () => {
  let wrapper: VueWrapper | null = null;
  let fake: BrowserFake;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });

  async function mountApp(client: MailClient = fake): Promise<VueWrapper> {
    const mounted = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = mounted;
    await flushPromises();
    await fake.controls.flush();
    await flushPromises();
    return mounted;
  }

  async function openCardFromList(w: VueWrapper): Promise<void> {
    document.body.dispatchEvent(keydown('c'));
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    await flushPromises();
  }

  /** The inline card shows in the central pane with all chrome visible and no backdrop. */
  function expectInlineCardInCentral(w: VueWrapper): void {
    expect(w.find('[data-test="compose-backdrop"]').exists()).toBe(false);
    expect(w.find('.compose-backdrop').exists()).toBe(false);
    const central = w.get('[data-test="central-surface"]');
    const card = central.get('[data-test="compose-card"]');
    // The card replaces the list: it is the central surface's only child.
    expect(central.element.firstElementChild?.getAttribute('data-test')).toBe('compose-card');
    expect(central.element.children).toHaveLength(1);
    expect(w.find('.inbox-list').exists()).toBe(false);
    expect(w.find('[data-test="conversation-row-conv-01"]').exists()).toBe(false);
    // No drafts drawer was opened instead.
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    // The app chrome stays visible and the contact pane stays non-inert.
    expect(w.find('[data-test="rail-inbox"]').exists()).toBe(true);
    expect(w.find('[data-test="compose-trigger"]').exists()).toBe(true);
    expect(central.attributes('inert')).toBeUndefined();
    const contact = w.get('[data-test="contact-column"]');
    expect(contact.attributes('inert')).toBeUndefined();
    // Card contents and the no-Send footer.
    expect(card.find('[data-test="draft-to"]').exists()).toBe(true);
    expect(card.find('[data-test="draft-body"]').exists()).toBe(true);
    expect(card.find('[data-test="draft-status"]').exists()).toBe(true);
    const footer = card.find('.composer-footer');
    expect(footer.findAll('button').map((button) => button.text().trim())).toEqual(['Save and close', 'Discard…']);
    expect(card.findAll('button').every((button) => !/send/i.test(button.text()))).toBe(true);
  }

  it('has a split-header compose glyph with the C aria-label', async () => {
    fake = createBrowserFakeMailClient();
    const w = await mountApp();
    const glyph = w.get('[data-test="compose-trigger"]');
    expect(glyph.attributes('aria-label')).toBe('Compose new local draft (C)');
    expect(glyph.attributes('title')).toBe('Compose new local draft — C');
    expect(glyph.element.getAttribute('disabled')).toBeNull();
  });

  it('opens the inline card in the central pane when pressing c in the list, edits the draft, and closes through the protected flush', async () => {
    fake = createBrowserFakeMailClient();
    const w = await mountApp();
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    await openCardFromList(w);
    expectInlineCardInCentral(w);
    const card = w.get('[data-test="compose-card"]');
    expect((await fake.listDrafts())).toHaveLength(1);
    expect((await fake.listDrafts())[0]?.source).toEqual({ kind: 'new_message' });
    // A second c must not stack another editor surface or draft.
    document.body.dispatchEvent(keydown('c'));
    await flushPromises();
    expect(w.findAll('[data-test="compose-card"]')).toHaveLength(1);
    expect((await fake.listDrafts())).toHaveLength(1);
    // The card fields wire to drafts.setContent and flush on close.
    await card.find('[data-test="draft-subject"]').setValue('Inline subject');
    await card.find('[data-test="close-composer"]').trigger('click');
    await flushPromises();
    await waitFor(() => !w.find('[data-test="compose-card"]').exists());
    // The list is back after the card closed.
    expect(w.find('.inbox-list').exists()).toBe(true);
    const summaries = await fake.listDrafts();
    expect(summaries).toHaveLength(1); // closed = flushed and kept, not discarded
    const saved = await fake.getDraft(summaries[0]!.ref);
    expect(saved.content.subject).toBe('Inline subject');
  });

  it('opens the inline card in the central pane when clicking the header compose glyph', async () => {
    fake = createBrowserFakeMailClient();
    const w = await mountApp();
    await w.get('[data-test="compose-trigger"]').trigger('click');
    await flushPromises();
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    expectInlineCardInCentral(w);
    expect((await fake.listDrafts())[0]?.source).toEqual({ kind: 'new_message' });
  });

  it('closes the inline card on Escape through the protected flush; a failed flush keeps the card open with the buffer intact', async () => {
    fake = createBrowserFakeMailClient();
    const gate = deferred<DraftReceipt>();
    let saves = 0;
    const client: MailClient = {
      ...fake,
      saveDraft: (command) => {
        saves += 1;
        return saves === 1 ? gate.promise : fake.saveDraft(command);
      },
    };
    const w = await mountApp(client);
    await openCardFromList(w);
    await w.find('[data-test="draft-body"]').setValue('last keystroke');

    window.dispatchEvent(keydown('Escape'));
    await flushPromises();
    // The flush is in flight: the card must stay open.
    expect(w.find('[data-test="compose-card"]').exists()).toBe(true);
    gate.reject({ kind: 'storage_unavailable' });
    await flushPromises();
    await waitFor(() => w.find('[data-test="draft-error"]').exists());
    // Failed close: the inline card stays visible with the exact buffer.
    expect(w.find('[data-test="compose-card"]').exists()).toBe(true);
    expect(w.find('.inbox-list').exists()).toBe(false);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('last keystroke');

    // Retry the save, then Escape closes the card through the protected flush.
    await w.find('[data-test="retry-draft-save"]').trigger('click');
    await flushPromises();
    window.dispatchEvent(keydown('Escape'));
    await flushPromises();
    await waitFor(() => !w.find('[data-test="compose-card"]').exists());
    expect(w.find('.inbox-list').exists()).toBe(true);
    const saved = await fake.getDraft((await fake.listDrafts())[0]!.ref);
    expect(saved.content.bodyText).toBe('last keystroke');
  });

  it('docks the inline card at the bottom of the reader pane when pressing c in the reader (no backdrop, reader stays visible)', async () => {
    fake = createBrowserFakeMailClient();
    const w = await mountApp();
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushPromises();
    await waitFor(() => w.find('[data-test="reader"]').exists());
    document.body.dispatchEvent(keydown('c'));
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    // The reader stays open; the card docks at the BOTTOM of the reader pane.
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    const pane = w.find('section.reader-pane');
    expect(pane.find('[data-test="compose-card"]').exists()).toBe(true);
    expect(pane.element.lastElementChild?.getAttribute('data-test')).toBe('compose-card');
    expect(pane.element.firstElementChild?.getAttribute('data-test')).toBe('reader');
    // No backdrop anywhere; the central surface still shows the reader, not the list.
    expect(w.find('[data-test="compose-backdrop"]').exists()).toBe(false);
    expect(w.find('.compose-backdrop').exists()).toBe(false);
    expect(w.find('.inbox-list').exists()).toBe(false);
    expect(w.findAll('[data-test="compose-card"]')).toHaveLength(1);
    expect((await fake.listDrafts())[0]?.source).toEqual({ kind: 'new_message' });
  });

  it('ignores c with modifiers, during IME, and in editable targets', async () => {
    fake = createBrowserFakeMailClient();
    const w = await mountApp();
    document.body.dispatchEvent(keydown('c', { ctrlKey: true }));
    document.body.dispatchEvent(keydown('c', { metaKey: true }));
    document.body.dispatchEvent(keydown('c', { altKey: true }));
    document.body.dispatchEvent(keydown('C', { shiftKey: true }));
    document.body.dispatchEvent(keydown('c', { keyCode: 229 }));
    await flushPromises();
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(keydown('c'));
    await flushPromises();
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    input.remove();
    expect((await fake.listDrafts())).toHaveLength(0);
  });

  it('runs the palette action "Compose new local draft" found by "new message"', async () => {
    fake = createBrowserFakeMailClient();
    const w = await mountApp();
    await w.get('[data-test="palette-trigger"]').trigger('click');
    await flushPromises();
    await w.get('[data-test="action-query"]').setValue('new message');
    await flushPromises();
    const option = w.get('#action-compose');
    expect(option.text()).toContain('Compose new local draft');
    expect(option.get('kbd').text()).toBe('C');
    await option.trigger('click');
    await flushPromises();
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    expectInlineCardInCentral(w);
    expect((await fake.listDrafts())[0]?.source).toEqual({ kind: 'new_message' });
  });

  it('gates compose while another utility drawer is open (no hidden key-owning card)', async () => {
    fake = createBrowserFakeMailClient();
    const w = await mountApp();
    await w.find('[data-test="rail-activity"]').trigger('click');
    await waitFor(() => w.find('[data-test="utility-drawer"]').exists());
    // The glyph is disabled and the C key does nothing while the drawer covers central.
    expect(w.get('[data-test="compose-trigger"]').attributes('disabled')).toBeDefined();
    document.body.dispatchEvent(keydown('c'));
    await flushPromises();
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    expect((await fake.listDrafts())).toHaveLength(0);
    // With the drawer closed, compose works again.
    await w.find('[data-test="drawer-close"]').trigger('click');
    await waitFor(() => !w.find('[data-test="utility-drawer"]').exists());
    document.body.dispatchEvent(keydown('c'));
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    expectInlineCardInCentral(w);
  });

  it('suppresses mailbox shortcuts while the inline card is open', async () => {
    fake = createBrowserFakeMailClient();
    let archives = 0;
    const client: MailClient = {
      ...fake,
      setArchived: (command) => {
        archives += 1;
        return fake.setArchived(command);
      },
    };
    const w = await mountApp(client);
    await openCardFromList(w);
    await w.find('[data-test="draft-body"]').setValue('e j k stay text');
    for (const key of ['e', 'j', 'k', 'Enter', 'x', 'g', 'E']) window.dispatchEvent(keydown(key, key === 'E' ? { shiftKey: true } : {}));
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(archives).toBe(0);
    expect(fake.controls.activity()).toEqual([]);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('e j k stay text');
    expect(w.find('[data-test="search-input"]').exists()).toBe(false);
  });
});

describe('ComposeCard fallback reason (reply draft that cannot show its thread)', () => {
  let wrapper: VueWrapper | null = null;
  afterEach(() => { wrapper?.unmount(); wrapper = null; });
  const replySource = { kind: 'reply', conversation: { accountId: 'fixture-account', conversationId: 'conv-01' }, sourceMessageId: 'm1' } as const;
  const noticeFor = (notice: string | null) => {
    wrapper?.unmount();
    wrapper = mount(ComposeCard, { props: cardProps({ source: replySource, recipientLabel: 'Ada', notice }) });
    return wrapper.find('[data-test="compose-card-notice"]');
  };

  it.each([
    [REPLY_REASONS.noLatestMessage.text, 'Source conversation unavailable: no latest message.'],
    [REPLY_REASONS.retainedSnapshot.text, 'Source conversation unavailable: retained snapshot.'],
    [REPLY_REASONS.incomplete.text, 'Source conversation unavailable: incomplete cached conversation.'],
    [REPLY_REASONS.headerMismatch.text, 'Source conversation unavailable: reply headers do not match the latest message.'],
    [sourceLoadErrorReason('not found'), 'Source conversation unavailable: could not be loaded: not found.'],
    [sourceLoadErrorReason(null), 'Source conversation unavailable: could not be loaded.'],
  ])('shows the failure "%s" as "unavailable: <reason>" and keeps the sentence in the title', (reason, line) => {
    const notice = noticeFor(reason);
    expect(notice.text()).toBe(`${line} Editing locally; nothing is sent.`);
    expect(notice.attributes('title')).toBe(reason);
    expect(notice.attributes('role')).toBe('note');
  });

  it.each([
    [REPLY_REASONS.notOpen.text, 'Source conversation not open.'],
    [REPLY_REASONS.stillLoading.text, 'Source conversation still loading.'],
    [REPLY_REASONS.otherAccount.text, 'Source conversation belongs to another account.'],
  ])('states the navigation reason "%s" as a fact, never as "unavailable"', (reason, line) => {
    const notice = noticeFor(reason);
    expect(notice.text()).toBe(`${line} Editing locally; nothing is sent.`);
    expect(notice.text()).not.toContain('unavailable');
    expect(notice.attributes('title')).toBe(reason);
    expect(notice.attributes('role')).toBe('note');
  });

  it('shows an unknown reason as written, never a vague word, and no line without a reason', () => {
    expect(noticeFor('Something specific broke.').text()).toBe('Source conversation unavailable: Something specific broke. Editing locally; nothing is sent.');
    expect(noticeFor(null).exists()).toBe(false);
  });
});
