/** UX-04 UI tests: ActionNotice lifecycle, Z dispatch precedence, and undo journeys. */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import { createBrowserFakeMailClient, type BrowserFake } from '../src/lib/ipc/browser-fake';
import { fixtureRef } from './helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

function key(key: string, options: KeyboardEventInit = {}): void {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...options }));
}

async function mountApp(fake: BrowserFake): Promise<VueWrapper> {
  wrapper = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

async function archiveViaKey(w: VueWrapper, conversationId: string): Promise<void> {
  (w.get(`[data-test="conversation-row-${conversationId}"]`).element as HTMLElement).focus();
  key('e');
  await flushPromises();
}

describe('UX-04 action notice and undo', () => {
  it('shows the notice lifecycle per activity status and replaces, never stacks', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    expect(w.find('[data-test="action-notice-text"]').exists()).toBe(false);

    fake.controls.behavior.hold = true;
    await archiveViaKey(w, 'conv-01');
    expect(w.get('[data-test="action-notice-label"]').text()).toContain('Mark Done (Archive)');
    expect(w.get('[data-test="action-notice-label"]').text()).toContain('Fixture thread 1');
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Accepted locally, not yet confirmed');
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(true);
    expect(w.get('[data-test="action-notice-hint"]').text()).toBe('Z');

    // A newer action replaces the slot: still exactly one notice.
    await archiveViaKey(w, 'conv-02');
    expect(w.findAll('[data-test="action-notice-text"]')).toHaveLength(1);
    expect(w.get('[data-test="action-notice-label"]').text()).toContain('Fixture thread 2');

    fake.controls.release();
    await flushPromises();
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Confirmed');
    fake.controls.behavior.hold = false;

    fake.controls.behavior.failNext = 1;
    fake.controls.behavior.failureKind = 'provider_rejected';
    await archiveViaKey(w, 'conv-03');
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Failed — restored, see Activity');
    expect(w.find('[data-test="conversation-row-conv-03"]').exists()).toBe(true);

    fake.controls.behavior.failureKind = 'outcome_unknown';
    fake.controls.behavior.failNext = 1;
    await archiveViaKey(w, 'conv-04');
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Outcome unknown — see Activity');
  });

  it('undoes the last action with Z, restoring the row and returning focus to it', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await archiveViaKey(w, 'conv-05');
    expect(w.find('[data-test="conversation-row-conv-05"]').exists()).toBe(false);
    key('z');
    await flushPromises();
    expect(w.find('[data-test="conversation-row-conv-05"]').exists()).toBe(true);
    expect(w.get('[aria-current="true"]').attributes('data-test')).toBe('conversation-row-conv-05');
    expect(document.activeElement?.getAttribute('data-test')).toBe('conversation-row-conv-05');
    expect(w.find('[data-test="action-notice-text"]').exists()).toBe(false);
    expect(fake.controls.activity().some((op) => op.status === 'cancelled' || op.undoOf !== undefined)).toBe(true);
  });

  it('keeps Undo reachable in the empty-Inbox state and restores the last row (BROWSE-08)', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    for (let i = 1; i <= 17; i += 1) {
      const id = `conv-${String(i).padStart(2, '0')}`;
      await fake.setArchived({ conversation: fixtureRef(id), archived: true, requestId: `seed-${id}` });
    }
    await fake.controls.flush();
    await flushPromises();
    await archiveViaKey(w, 'conv-18');
    expect(w.find('[data-test="inbox-empty"]').exists()).toBe(true);
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(true);
    await w.get('[data-test="action-notice-undo"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="conversation-row-conv-18"]').exists()).toBe(true);
    expect(w.get('[aria-current="true"]').attributes('data-test')).toBe('conversation-row-conv-18');
  });

  it('suppresses Z in palette input, open overlay, and reader disclosures; typing mutates nothing (BROWSE-10 style)', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await archiveViaKey(w, 'conv-01');
    const opCount = (): number => fake.controls.activity().length;
    expect(opCount()).toBe(1);

    // Palette: the input owns typing; z is a character, not an undo.
    await w.get('[data-test="palette-trigger"]').trigger('click');
    await flushPromises();
    await w.get('#action-query').setValue('z');
    key('z');
    await flushPromises();
    expect((w.get('#action-query').element as HTMLInputElement).value).toBe('z');
    expect(opCount()).toBe(1);
    key('Escape');
    await flushPromises();

    // Navigator overlay: covered keys are inert.
    (w.get('[data-test="conversation-row-conv-02"]').element as HTMLElement).focus();
    key('ArrowLeft');
    await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(true);
    key('z');
    await flushPromises();
    expect(opCount()).toBe(1);
    key('Escape');
    await flushPromises();

    // Open reader message-details disclosure suppresses undo…
    await w.get('[data-test="conversation-row-conv-02"]').trigger('click');
    await flushPromises();
    const details = w.get('[data-test^="message-details-"]').element as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await flushPromises();
    key('z');
    await flushPromises();
    expect(opCount()).toBe(1);
    // …and after dismissal the same key undoes.
    details.open = false;
    details.dispatchEvent(new Event('toggle'));
    await flushPromises();
    key('z');
    await flushPromises();
    expect(opCount()).toBe(2);
    expect(w.find('[data-test="action-notice-text"]').exists()).toBe(false);
  });

  it('a visible draft editor owns keys: z performs no undo', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await archiveViaKey(w, 'conv-01');
    await w.get('[data-test="rail-drafts"]').trigger('click');
    await flushPromises();
    await w.get('[data-test="new-draft"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
    key('z');
    await flushPromises();
    expect(fake.controls.activity()).toHaveLength(1);
    expect(w.find('[data-test="composer"]').exists()).toBe(true);
  });

  it('undoes from the reader with Z and leaves reader focus unchanged', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await w.get('[data-test="conversation-row-conv-02"]').trigger('click');
    await flushPromises();
    key('e');
    await flushPromises();
    // Reader auto-advanced to a surviving neighbor after the archive.
    expect(w.get('.reader-subject').text()).toContain('Fixture thread 3');
    key('z');
    await flushPromises();
    // Restored into the inbox; the reader stays open on its neighbor, focus unchanged.
    expect(await fake.getConversation(fixtureRef('conv-02'))).toMatchObject({ isInInbox: true });
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect(w.get('.reader-subject').text()).toContain('Fixture thread 3');
    expect(fake.controls.activity().some((op) => op.undoOf !== undefined)).toBe(true);
  });

  it('re-points the notice to the newest undoable operation after superseded', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await archiveViaKey(w, 'conv-01');
    // A newer action is accepted outside the UI path, so the slot still points at op-0001.
    await fake.setArchived({ conversation: fixtureRef('conv-07'), archived: true, requestId: 'external' });
    await fake.controls.flush();
    await flushPromises();
    key('z');
    await flushPromises();
    expect(w.get('[data-test="command-error"]').text()).toContain('superseded by a newer action');
    expect(w.get('[data-test="action-notice-label"]').text()).toContain('conv-07');
    expect(fake.controls.activity().find((op) => op.id === 'op-0001')?.status).toBe('confirmed');
    // The re-pointed slot is undoable again.
    key('z');
    await flushPromises();
    expect(w.find('[data-test="conversation-row-conv-07"]').exists()).toBe(true);
    expect(w.find('[data-test="action-notice-text"]').exists()).toBe(false);
  });

  it('exposes the authoritative expired decision with the recovery wording', async () => {
    let offsetMs = 0;
    const fake = createBrowserFakeMailClient(() => new Date(Date.now() + offsetMs).toISOString());
    const w = await mountApp(fake);
    await archiveViaKey(w, 'conv-01');
    // Advance the backend clock past the window, then force a refresh.
    offsetMs = 11_000;
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    key('z');
    await flushPromises();
    expect(w.get('[data-test="action-notice-expired"]').text())
      .toBe('Undo expired — Mark Not Done restores the whole conversation to Inbox');
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    expect(w.get('[data-test="command-error"]').text()).toContain('undo window expired');
    // Activity (and from there Mark Not Done) stays reachable.
    await w.get('[data-test="rail-activity"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(true);
  });

  it('offers Undo in the palette exactly while the undo window is open', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await w.get('[data-test="palette-trigger"]').trigger('click');
    await flushPromises();
    expect(w.find('#action-undo').exists()).toBe(false);
    key('Escape');
    await flushPromises();
    await archiveViaKey(w, 'conv-01');
    await w.get('[data-test="palette-trigger"]').trigger('click');
    await flushPromises();
    expect(w.find('#action-undo').exists()).toBe(true);
    key('Escape');
    await flushPromises();
    key('z');
    await flushPromises();
    await w.get('[data-test="palette-trigger"]').trigger('click');
    await flushPromises();
    expect(w.find('#action-undo').exists()).toBe(false);
  });
});
