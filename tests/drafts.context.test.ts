/**
 * Drafts as a list context (not a drawer): entering and leaving, opening a
 * draft by navigating to its source thread (the docked reply composer) or the
 * inline card, the fallback that keeps every draft editable, the protected
 * flush before another open, the in-flow recovery lines, and inert mailbox
 * shortcuts. The lifecycle matrix itself lives in drafts.component.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import type { DraftSource, DraftSummary, MailClient } from '../src/lib/ipc/client';
import { createBrowserFakeMailClient, deferred, fixtureRef, useGmailMode, waitFor, type BrowserFake } from './helpers';

let app: VueWrapper | null = null;
afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = ''; });

const REPLY_SOURCE: DraftSource = { kind: 'reply', conversation: fixtureRef('conv-01'), sourceMessageId: 'conv-01-m3' };
const key = async (value: string, init: KeyboardEventInit = {}, target: EventTarget = window) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init }));
  await flushPromises();
};
const title = (w: VueWrapper) => w.get('[data-test="inbox-title"]').text();
const rail = (w: VueWrapper) => w.get('[data-test="rail-drafts"]');
const rows = (w: VueWrapper) => w.findAll('[data-test="draft-list"] [data-drawer-row]');
const body = (w: VueWrapper) => (w.get('[data-test="draft-body"]').element as HTMLTextAreaElement).value;

async function mountApp(fake: BrowserFake, client: MailClient = fake): Promise<VueWrapper> {
  app = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
  await flushPromises();
  return app;
}
async function enter(w: VueWrapper): Promise<void> {
  await rail(w).trigger('click'); await flushPromises();
  await waitFor(() => w.find('[data-test="drafts-pane"]').exists());
}
async function seed(fake: BrowserFake): Promise<{ reply: DraftSummary; plain: DraftSummary }> {
  await fake.createDraft({ requestId: 'ctx-reply', source: REPLY_SOURCE, initialContent: null });
  await fake.createDraft({ requestId: 'ctx-plain', source: { kind: 'new_message' }, initialContent: { to: 'bo@example.test', cc: '', subject: 'Plain subject', bodyText: 'plain body' } });
  const summaries = await fake.listDrafts();
  return { reply: summaries.find((d) => d.source.kind === 'reply')!, plain: summaries.find((d) => d.source.kind === 'new_message')! };
}
/** Type into the docked reply composer or the card, then wait for the save to settle. */
async function typeBody(w: VueWrapper, text: string): Promise<void> {
  await w.get('[data-test="draft-body"]').setValue(text);
  await flushPromises();
}

describe('entering and leaving the Drafts context', () => {
  it('the rail item is a plain navigation item; the h1, aria-current, coverage and focus name the list', async () => {
    const fake = createBrowserFakeMailClient();
    const { reply } = await seed(fake);
    const w = await mountApp(fake);
    expect(rail(w).attributes('aria-current')).toBeUndefined();
    await enter(w);
    expect(title(w)).toBe('Drafts');
    expect(w.findAll('h1').map((h) => h.text())).toEqual(['Drafts']);
    expect(w.get('[data-test="inbox-title"]').classes()).not.toContain('visually-hidden');
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(rail(w).attributes('aria-current')).toBe('page');
    expect(rail(w).attributes('aria-expanded')).toBeUndefined();
    expect(w.get('[data-test="central-surface"]').attributes('aria-label')).toBe('Drafts');
    expect(w.get('[data-test="drafts-coverage"]').text()).toContain('Local to this device · never sent');
    expect(rows(w)).toHaveLength(2);
    expect(w.find('[data-test="draft-list"] li[aria-current="true"]').exists()).toBe(true);
    expect(document.activeElement).toBe(rows(w)[0]!.element);
    expect(w.find(`[data-test="open-draft-${reply.ref.draftId}"]`).exists()).toBe(true);
    // Mailbox chrome that does not apply is absent: no starred filter, no thread count.
    expect(w.find('[data-test="starred-filter"]').exists()).toBe(false);
    expect(w.find('[data-test="conversation-row-conv-01"]').exists()).toBe(false);
  });

  it('the palette action "Go to local Drafts" and the header Back enter and leave it; the rail item loses aria-current in the Inbox', async () => {
    const fake = createBrowserFakeMailClient();
    await seed(fake);
    const w = await mountApp(fake);
    await w.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    const action = w.get('#action-drafts');
    expect(action.text()).toContain('Go to local Drafts');
    await action.trigger('click'); await flushPromises();
    expect(title(w)).toBe('Drafts');
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Inbox');
    expect(rail(w).attributes('aria-current')).toBeUndefined();
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(false);
  });

  it('Escape returns to the Inbox row that was current', async () => {
    const fake = createBrowserFakeMailClient();
    await seed(fake);
    const w = await mountApp(fake);
    await key('j');
    const current = w.get('[data-test="conversation-row-conv-02"]');
    expect(current.attributes('aria-current')).toBe('true');
    await enter(w);
    await key('Escape');
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(false);
    expect(w.get('[data-test="conversation-row-conv-02"]').attributes('aria-current')).toBe('true');
    expect(document.activeElement).toBe(w.get('[data-test="conversation-row-conv-02"]').element);
  });

  it('keeps G chords and the destination navigator working from a draft row', async () => {
    const fake = createBrowserFakeMailClient();
    await seed(fake);
    const w = await mountApp(fake);
    await enter(w);
    const first = rows(w)[0]!.element;
    await key('g', {}, first); await key('e', {}, first);
    expect(title(w)).toBe('Cached Done');
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Drafts');
    expect(rows(w)).toHaveLength(2);
    await key('ArrowLeft', {}, rows(w)[0]!.element);
    expect(w.find('[data-test="destination-navigator"], .action-overlay').exists()).toBe(true);
  });

  it('is only offered with an account', async () => {
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake);
    const w = await mountApp(fake);
    expect(w.find('[data-test="rail-drafts"]').exists()).toBe(true);
    await w.get('[data-test="rail-account"]').trigger('click'); await flushPromises();
    await w.get('[data-test="account-disconnect"]').trigger('click'); await flushPromises();
    await waitFor(() => w.find('[data-test="account-connect"]').exists());
    expect(w.find('[data-test="rail-drafts"]').exists()).toBe(false);
    await w.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    expect(w.find('#action-drafts').exists()).toBe(false);
  });

  it('keeps mailbox shortcuts inert in the list: e, z, u, s, x, h and r never reach mail, c still composes', async () => {
    const fake = createBrowserFakeMailClient();
    await seed(fake);
    const archive = vi.spyOn(fake, 'setArchived');
    const read = vi.spyOn(fake, 'setRead');
    const star = vi.spyOn(fake, 'setStarred');
    const w = await mountApp(fake);
    await enter(w);
    const row = rows(w)[0]!.element;
    for (const letter of ['e', 'E', 'z', 'u', 'U', 's', 'x', 'X', 'h', 'r']) await key(letter, letter === 'E' || letter === 'U' || letter === 'X' ? { shiftKey: true } : {}, row);
    for (const letter of ['e', 'z', 'x', 'h']) await key(letter);
    expect(archive).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(star).not.toHaveBeenCalled();
    expect(w.find('[data-test="selection-live"]').exists()).toBe(false);
    expect(w.find('[data-test="reminder-form"]').exists()).toBe(false);
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    // C and the header glyph open a new message card from the list.
    await key('c', {}, row);
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    expect(w.get('[data-test="compose-card"]').attributes('aria-label')).toBe('New Message');
  });

  it('New draft does what C does: the card replaces the list, and closing it returns to the list on the new draft', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await enter(w);
    expect(w.get('[data-test="draft-list-empty"]').text()).toBe('No local drafts.');
    await w.get('[data-test="new-draft"]').trigger('click'); await flushPromises();
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(false);
    expect(rail(w).attributes('aria-current')).toBeUndefined();
    await typeBody(w, 'made from the list');
    await key('Escape');
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    expect(title(w)).toBe('Drafts');
    expect(rows(w)).toHaveLength(1);
    expect(rail(w).attributes('aria-current')).toBe('page');
    expect(document.activeElement).toBe(rows(w)[0]!.element);
    expect((await fake.getDraft((await fake.listDrafts())[0]!.ref)).content.bodyText).toBe('made from the list');
  });
});

describe('opening a draft', () => {
  it('a reply draft opens its source thread with the composer docked; Esc closes it, Esc again returns to the same row', async () => {
    const fake = createBrowserFakeMailClient();
    const { reply, plain } = await seed(fake);
    const loads = vi.spyOn(fake, 'getConversation');
    const w = await mountApp(fake);
    await enter(w);
    // Make the reply draft the second row's neighbour: open the first row's sibling.
    const replyRow = w.get(`[data-test="open-draft-${reply.ref.draftId}"]`);
    await replyRow.trigger('click');
    await waitFor(() => w.find('[data-test="reply-composer"]').exists());
    await flushPromises();
    expect(loads.mock.calls.map(([ref]) => ref.conversationId)).toContain('conv-01');
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(false);
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    expect(w.find('[data-test="compose-card-notice"]').exists()).toBe(false);
    expect(w.get('[data-test="reply-source"]').attributes('data-source-conversation')).toBe('conv-01');
    // The reader offers no neighbour navigation from this origin.
    expect(w.find('[data-test="reader-next"], [data-test="reader-prev"]').exists()).toBe(false);
    loads.mockClear();
    await key('j');
    expect(loads).not.toHaveBeenCalled();
    await typeBody(w, 'reply typed in the docked composer');
    await key('Escape');
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(false);
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect((await fake.getDraft(reply.ref)).content.bodyText).toBe('reply typed in the docked composer');
    await key('Escape');
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(title(w)).toBe('Drafts');
    const row = w.get(`[data-test="open-draft-${reply.ref.draftId}"]`);
    expect(row.element.closest('li')!.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(row.element);
    expect(w.find(`[data-test="open-draft-${plain.ref.draftId}"]`).element.closest('li')!.getAttribute('aria-current')).toBeNull();
  });

  it('a new-message draft opens in the inline card with its content; closing returns to the list and the row', async () => {
    const fake = createBrowserFakeMailClient();
    const { plain } = await seed(fake);
    const w = await mountApp(fake);
    await enter(w);
    await w.get(`[data-test="open-draft-${plain.ref.draftId}"]`).trigger('click');
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    await flushPromises();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.find('[data-test="compose-card-notice"]').exists()).toBe(false);
    expect(w.get('[data-test="compose-card"]').attributes('aria-label')).toBe('New Message');
    expect((w.get('[data-test="draft-to"]').element as HTMLInputElement).value).toBe('bo@example.test');
    expect(body(w)).toBe('plain body');
    await w.get('[data-test="close-composer"]').trigger('click'); await flushPromises();
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    const row = w.get(`[data-test="open-draft-${plain.ref.draftId}"]`);
    expect(row.element.closest('li')!.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(row.element);
  });

  it('Back while the source conversation loads never docks a composer, and the draft stays in the list', async () => {
    const fake = createBrowserFakeMailClient();
    const { reply } = await seed(fake);
    const pending = deferred<Awaited<ReturnType<MailClient['getConversation']>>>();
    const client: MailClient = { ...fake, getConversation: (ref, ...rest) => ref.conversationId === 'conv-01' ? pending.promise : fake.getConversation(ref, ...rest) };
    const w = await mountApp(fake, client);
    await enter(w);
    await w.get(`[data-test="open-draft-${reply.ref.draftId}"]`).trigger('click'); await flushPromises();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    await key('Escape');
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(true);
    pending.resolve(await fake.getConversation(fixtureRef('conv-01')));
    await flushPromises();
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(false);
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(true);
    expect(rows(w)).toHaveLength(2);
  });

  it('a second open while the first is loading wins: the first never docks on the wrong conversation', async () => {
    const fake = createBrowserFakeMailClient();
    const { reply, plain } = await seed(fake);
    const pending = deferred<Awaited<ReturnType<MailClient['getConversation']>>>();
    const client: MailClient = { ...fake, getConversation: (ref, ...rest) => ref.conversationId === 'conv-01' ? pending.promise : fake.getConversation(ref, ...rest) };
    const w = await mountApp(fake, client);
    await enter(w);
    const app = w.vm as unknown as { openDraftFromList(draft: DraftSummary): Promise<void> };
    void app.openDraftFromList(reply);
    await flushPromises();
    void app.openDraftFromList(plain);
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    pending.resolve(await fake.getConversation(fixtureRef('conv-01')));
    await flushPromises();
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(false);
    expect(body(w)).toBe('plain body');
    expect(w.get('[data-test="compose-card"]').attributes('aria-label')).toBe('New Message');
  });

  it('opening another draft flushes the active editor first; a failed flush keeps it open with its error and navigates nowhere', async () => {
    const fake = createBrowserFakeMailClient();
    const { reply, plain } = await seed(fake);
    const loads = vi.spyOn(fake, 'getConversation');
    let failSaves = false;
    const client: MailClient = { ...fake, getConversation: fake.getConversation, saveDraft: (command) => failSaves ? Promise.reject({ kind: 'storage_unavailable' }) : fake.saveDraft(command) };
    const w = await mountApp(fake, client);
    await enter(w);
    await w.get(`[data-test="open-draft-${plain.ref.draftId}"]`).trigger('click');
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    await flushPromises();
    failSaves = true;
    await typeBody(w, 'plain body edited, not saved');
    loads.mockClear();
    const app = w.vm as unknown as { openDraftFromList(draft: DraftSummary): Promise<void> };
    await app.openDraftFromList(reply);
    await flushPromises();
    expect(loads).not.toHaveBeenCalled();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.find('[data-test="compose-card"]').exists()).toBe(true);
    expect(body(w)).toBe('plain body edited, not saved');
    expect(w.find('[data-test="draft-error"]').exists()).toBe(true);
    // Once saving works again, the same request flushes the edit and then navigates.
    failSaves = false;
    await app.openDraftFromList(reply);
    await waitFor(() => w.find('[data-test="reply-composer"]').exists());
    expect((await fake.getDraft(plain.ref)).content.bodyText).toBe('plain body edited, not saved');
    expect(w.get('[data-test="reply-source"]').attributes('data-source-conversation')).toBe('conv-01');
  });
});

describe('a reply draft whose source cannot host it', () => {
  /** The Amber line: the terse reason is visible text, the full sentence stays in the title. */
  const notice = (label: string) => `Source conversation unavailable: ${label}. Editing locally; nothing is sent.`;

  async function openReply(fake: BrowserFake, client: MailClient = fake) {
    const { reply } = await seed(fake);
    const w = await mountApp(fake, client);
    await enter(w);
    await w.get(`[data-test="open-draft-${reply.ref.draftId}"]`).trigger('click');
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    await flushPromises();
    return { w, reply };
  }
  function expectEditableInCard(w: VueWrapper, reason: RegExp, label: string): void {
    // The same draft, in the Drafts context's card, titled as the reply, with one Amber line.
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.find('[data-test="reply-composer"]').exists()).toBe(false);
    expect(title(w)).toBe('Drafts');
    expect(w.get('[data-test="compose-card"]').attributes('aria-label')).toBe('Reply draft to ada@example.test');
    const line = w.get('[data-test="compose-card-notice"]');
    expect(line.text()).toBe(notice(label));
    expect(line.attributes('title')).toMatch(reason);
    expect(line.attributes('role')).toBe('note');
    expect(w.get('[data-test="reply-source"]').attributes('data-source-conversation')).toBe('conv-01');
    expect(w.get('[data-test="draft-to"]').attributes('disabled')).toBeUndefined();
    expect(w.get('[data-test="draft-body"]').attributes('disabled')).toBeUndefined();
    expect(w.findAll('button').every((button) => !/send/i.test(button.text()))).toBe(true);
  }

  it('opens in the card with the reason when the conversation fails to load, keeping and saving every edit', async () => {
    const fake = createBrowserFakeMailClient();
    const client: MailClient = { ...fake, getConversation: (ref, ...rest) => ref.conversationId === 'conv-01' ? Promise.reject({ kind: 'not_found' }) : fake.getConversation(ref, ...rest) };
    const { w, reply } = await openReply(fake, client);
    expectEditableInCard(w, /could not be loaded/, 'could not be loaded: not found');
    await typeBody(w, 'edited without the thread');
    await key('Escape');
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    expect(title(w)).toBe('Drafts');
    expect((await fake.getDraft(reply.ref)).content.bodyText).toBe('edited without the thread');
    expect(rows(w)).toHaveLength(2);
    expect(document.activeElement).toBe(w.get(`[data-test="open-draft-${reply.ref.draftId}"]`).element);
  });

  it('opens in the card for an incomplete or retained conversation (the same rule as Prepare reply)', async () => {
    const fake = createBrowserFakeMailClient();
    const { reply } = await seed(fake);
    fake.controls.markUnsupported('conv-01', 'Incomplete cached context', false);
    const w = await mountApp(fake);
    await enter(w);
    await w.get(`[data-test="open-draft-${reply.ref.draftId}"]`).trigger('click');
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    await flushPromises();
    expectEditableInCard(w, /incomplete/, 'incomplete cached conversation');
  });

  it('opens in the card for a source in another account', async () => {
    const fake = createBrowserFakeMailClient();
    const { reply } = await seed(fake);
    const foreign = (source: DraftSource): DraftSource => source.kind === 'reply' ? { ...source, conversation: { ...source.conversation, accountId: 'other-account' } } : source;
    const client: MailClient = {
      ...fake,
      listDrafts: async () => (await fake.listDrafts()).map((draft) => ({ ...draft, source: foreign(draft.source) })),
      getDraft: async (ref) => { const draft = await fake.getDraft(ref); return { ...draft, source: foreign(draft.source) }; },
    };
    const loads = vi.spyOn(fake, 'getConversation');
    const w = await mountApp(fake, client);
    await enter(w);
    await w.get(`[data-test="open-draft-${reply.ref.draftId}"]`).trigger('click');
    await waitFor(() => w.find('[data-test="compose-card"]').exists());
    await flushPromises();
    expect(loads).not.toHaveBeenCalled();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.get('[data-test="compose-card-notice"]').attributes('title')).toMatch(/another account/);
    expect(w.get('[data-test="compose-card-notice"]').text()).toBe(notice('belongs to another account'));
    expect(body(w)).toBe('');
  });
});

describe('triaging drafts in the list', () => {
  const discardOf = (w: VueWrapper, draftId: string) => w.get(`[data-test="draft-row-${draftId}"] [data-test="discard-draft"]`);

  it('shows a one-line plain-text preview of each body, and "No text yet" for an empty draft', async () => {
    const fake = createBrowserFakeMailClient();
    const { reply, plain } = await seed(fake);
    const w = await mountApp(fake);
    await enter(w);
    await waitFor(() => w.findAll('[data-test="draft-preview"]').length === 2);
    expect(w.get(`[data-test="draft-row-${plain.ref.draftId}"] [data-test="draft-preview"]`).text()).toBe('plain body');
    expect(w.get(`[data-test="draft-row-${reply.ref.draftId}"] [data-test="draft-preview"]`).text()).toBe('No text yet');
  });

  it('discards a draft only after the confirmation, announces it, and moves focus to the neighbouring row', async () => {
    const fake = createBrowserFakeMailClient();
    const { reply, plain } = await seed(fake);
    const w = await mountApp(fake);
    await enter(w);
    // Cancel: nothing is deleted.
    await discardOf(w, plain.ref.draftId).trigger('click'); await flushPromises();
    expect(w.get('[data-test="draft-discard-confirm"]').text()).toContain('Discard this local draft? This cannot be undone.');
    await key('Escape', {}, w.get('[data-test="confirm-discard-draft"]').element);
    expect(w.find('[data-test="draft-discard-confirm"]').exists()).toBe(false);
    expect(title(w)).toBe('Drafts');
    expect(await fake.listDrafts()).toHaveLength(2);
    // Confirm: the existing draft store is asked, the row leaves, the status is announced.
    await discardOf(w, plain.ref.draftId).trigger('click'); await flushPromises();
    await w.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect((await fake.listDrafts()).map((draft) => draft.ref.draftId)).toEqual([reply.ref.draftId]);
    expect(rows(w)).toHaveLength(1);
    expect(w.get('[data-test="draft-discard-status"]').text()).toBe('Local draft deleted');
    expect(document.activeElement).toBe(w.get(`[data-test="open-draft-${reply.ref.draftId}"]`).element);
    // The last draft: the empty state, focus on the pane.
    await discardOf(w, reply.ref.draftId).trigger('click'); await flushPromises();
    await w.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect(await fake.listDrafts()).toHaveLength(0);
    expect(w.get('[data-test="draft-list-empty"]').text()).toBe('No local drafts.');
    expect(document.activeElement).toBe(w.get('[data-test="drafts-pane"]').element);
  });

  it('keeps the draft and says so when the delete is not confirmed', async () => {
    const fake = createBrowserFakeMailClient();
    const { plain } = await seed(fake);
    const client: MailClient = { ...fake, deleteDraft: () => Promise.reject({ kind: 'storage_unavailable' }) };
    const w = await mountApp(fake, client);
    await enter(w);
    await discardOf(w, plain.ref.draftId).trigger('click'); await flushPromises();
    await w.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect(w.get('[data-test="draft-discard-error"]').text()).toContain('Draft not discarded');
    expect(await fake.listDrafts()).toHaveLength(2);
    expect(rows(w)).toHaveLength(2);
    expect(w.get('[data-test="draft-discard-status"]').text()).toBe('');
  });
});

describe('recovery lines in the Drafts list', () => {
  it('shows close-protection recovery in flow above the rows, and the global banner steps aside while the list is up', async () => {
    const fake = createBrowserFakeMailClient();
    await seed(fake);
    let subscriptions = 0;
    const client: MailClient = {
      ...fake,
      subscribeAppClose: async (listener) => { subscriptions += 1; if (subscriptions === 1) throw { kind: 'storage_unavailable' }; return fake.subscribeAppClose(listener); },
    };
    const w = await mountApp(fake, client);
    // Outside the list, close protection has its one global banner with the retry.
    await waitFor(() => w.find('.draft-close-recovery').exists());
    expect(w.findAll('[data-test="retry-close-setup"]')).toHaveLength(1);
    await enter(w);
    // In the list the same lines are in flow above the rows and the banner steps aside.
    expect(w.find('.draft-close-recovery').exists()).toBe(false);
    expect(w.findAll('[data-test="retry-close-setup"]')).toHaveLength(1);
    expect(w.get('[data-test="draft-close-setup-error"]').attributes('role')).toBe('alert');
    await w.get('[data-test="retry-close-setup"]').trigger('click'); await flushPromises();
    expect(w.find('[data-test="draft-close-setup-error"]').exists()).toBe(false);
  });
});
