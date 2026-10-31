/** UX-04 UI tests: ActionNotice lifecycle, Z dispatch precedence, and undo journeys. */
import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import { createBrowserFakeMailClient, type BrowserFake } from '../src/lib/ipc/browser-fake';
import type { InboxSnapshot, MailClient, UndoOperation, UndoReceipt } from '../src/lib/ipc/client';
import { useGmailMode } from './helpers';
import { fixtureRef } from './helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

function key(key: string, options: KeyboardEventInit = {}): void {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...options }));
}

async function mountApp(client: MailClient | BrowserFake): Promise<VueWrapper> {
  wrapper = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

/** Wraps the fake so every undoOperation call/receipt is observable in the test. */
function recordingUndo(fake: BrowserFake): { client: MailClient; undoCalls: UndoOperation[]; undoReceipts: UndoReceipt[] } {
  const undoCalls: UndoOperation[] = [];
  const undoReceipts: UndoReceipt[] = [];
  const client: MailClient = {
    ...fake,
    undoOperation: (command) => {
      undoCalls.push({ ...command });
      return fake.undoOperation(command).then((receipt) => {
        undoReceipts.push(receipt);
        return receipt;
      });
    },
  };
  return { client, undoCalls, undoReceipts };
}

/**
 * Wraps the fake so every `listConversations` read can be held open (stale
 * activity) and every `undo_operation` call counted. Released reads resolve
 * with the snapshot the test hands in.
 */
function holdableLists(fake: BrowserFake): {
  client: MailClient;
  undoCalls: UndoOperation[];
  hold(): void;
  releaseWith(snap: InboxSnapshot): void;
} {
  let holding = false;
  const held: Array<(snap: InboxSnapshot) => void> = [];
  const undoCalls: UndoOperation[] = [];
  const client: MailClient = {
    ...fake,
    undoOperation: (command) => {
      undoCalls.push({ ...command });
      return fake.undoOperation(command);
    },
    listConversations: () => {
      if (holding) return new Promise<InboxSnapshot>((resolve) => { held.push(resolve); });
      return fake.listConversations();
    },
  };
  return {
    client,
    undoCalls,
    hold: () => { holding = true; },
    releaseWith: (snap) => {
      holding = false;
      while (held.length > 0) held.shift()!(snap);
    },
  };
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
    // The refreshed row withdrew the window: no Undo control over a failed op.
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    expect(w.find('[data-test="action-notice-expired"]').exists()).toBe(false);
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
    // The slot survives the undo: the notice reports the restored outcome.
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Restored');
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(false);
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
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Restored');
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
    let holdLists = false;
    const heldLists: Array<(snap: InboxSnapshot) => void> = [];
    const client: MailClient = {
      ...fake,
      listConversations: () => {
        if (holdLists) return new Promise<InboxSnapshot>((resolve) => { heldLists.push(resolve); });
        return fake.listConversations();
      },
    };
    const w = await mountApp(client);
    await archiveViaKey(w, 'conv-01');
    // A newer action is accepted outside the UI path while every list read is
    // held back, so the slot still shows op-0001's window from stale activity.
    holdLists = true;
    await fake.setArchived({ conversation: fixtureRef('conv-07'), archived: true, requestId: 'external' });
    await fake.controls.flush();
    await flushPromises();
    key('z');
    // Release the reads: the superseded rejection refreshes with fresh activity
    // and the slot re-points at the newest still-undoable row.
    holdLists = false;
    const fresh = await fake.listConversations();
    while (heldLists.length > 0) heldLists.shift()!(fresh);
    await flushPromises();
    expect(w.get('[data-test="command-error"]').text()).toContain('superseded by a newer action');
    // The re-pointed slot never renders a raw conversation id as the subject.
    expect(w.get('[data-test="action-notice-label"]').text()).not.toContain('conv-07');
    expect(fake.controls.activity().find((op) => op.id === 'op-0001')?.status).toBe('confirmed');
    // The re-pointed slot is undoable again.
    key('z');
    await flushPromises();
    expect(w.find('[data-test="conversation-row-conv-07"]').exists()).toBe(true);
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Restored');
  });

  it('exposes the authoritative expired decision with the recovery wording', async () => {
    let offsetMs = 0;
    const fake = createBrowserFakeMailClient(() => new Date(Date.now() + offsetMs).toISOString());
    const held = holdableLists(fake);
    const w = await mountApp(held.client);
    await archiveViaKey(w, 'conv-01');
    // Hold every list read so the stale row keeps its undo window and Z really
    // reaches the backend instead of being gated locally by a refreshed row.
    held.hold();
    offsetMs = 11_000;
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    key('z');
    await flushPromises();
    expect(held.undoCalls).toHaveLength(1);
    // Release: the authoritative row no longer carries undoableUntil; the
    // expired branch refreshes first, then closes the slot window.
    held.releaseWith(await fake.listConversations());
    await flushPromises();
    expect(w.get('[data-test="action-notice-expired"]').text())
      .toBe('Undo expired — Mark Not Done restores the whole conversation to Inbox');
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    // The polite notice already announces the expiry; no double role=alert.
    expect(w.find('[data-test="command-error"]').exists()).toBe(false);
    // Activity (and from there Mark Not Done) stays reachable.
    await w.get('[data-test="rail-activity"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(true);
  });

  it('cannot re-undo after success while the activity read is stale (palette and key)', async () => {
    const fake = createBrowserFakeMailClient();
    const held = holdableLists(fake);
    const w = await mountApp(held.client);
    await archiveViaKey(w, 'conv-01');
    const stale = await fake.listConversations(); // pre-undo: op-0001 confirmed with a window
    held.hold();
    key('z'); // the undo succeeds; its write-back refresh is held
    await flushPromises();
    // Resolve the undo's refresh with the STALE snapshot: the activity row
    // still carries undoableUntil even though the undo succeeded.
    held.releaseWith(stale);
    await flushPromises();
    expect(held.undoCalls).toHaveLength(1);
    // The palette offers no Undo entry…
    await w.get('[data-test="palette-trigger"]').trigger('click');
    await flushPromises();
    expect(w.find('#action-undo').exists()).toBe(false);
    key('Escape');
    await flushPromises();
    // …and Z sends nothing: exactly one undo_operation in total.
    key('z');
    await flushPromises();
    expect(held.undoCalls).toHaveLength(1);
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

  it('reports a cancel-in-place undo as Cancelled with outcome cancelled', async () => {
    const fake = createBrowserFakeMailClient();
    const { client, undoReceipts } = recordingUndo(fake);
    const w = await mountApp(client);
    fake.controls.behavior.holdQueued = true;
    await archiveViaKey(w, 'conv-01');
    key('z');
    await flushPromises();
    // Explicit cancel-in-place outcome, not either/or with compensation.
    expect(undoReceipts).toHaveLength(1);
    expect(undoReceipts[0]!.outcome).toBe('cancelled');
    expect(undoReceipts[0]!.operationIds).toEqual([]);
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Cancelled');
    expect(fake.controls.activity().find((op) => op.id === 'op-0001')?.status).toBe('cancelled');
    expect(fake.controls.activity().some((op) => op.undoOf !== undefined)).toBe(false);
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    fake.controls.behavior.holdQueued = false;
  });

  it('reports a failed compensation as Restore failed — see Activity', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    fake.controls.behavior.hold = true;
    await archiveViaKey(w, 'conv-01');
    fake.controls.release(); // the archive confirms
    await flushPromises();
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Confirmed');
    fake.controls.behavior.failNext = 1;
    key('z'); // compensation is staged and re-held
    await flushPromises();
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Restoring…');
    fake.controls.release(); // the compensation runs and fails
    await flushPromises();
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Restore failed — see Activity');
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    expect(w.find('[data-test="action-notice-expired"]').exists()).toBe(false);
    fake.controls.behavior.hold = false;
  });

  it('sends exactly one undo_operation while a first undo is in flight (repeat, double-tap)', async () => {
    const fake = createBrowserFakeMailClient();
    const { client, undoCalls } = recordingUndo(fake);
    const w = await mountApp(client);
    await archiveViaKey(w, 'conv-01');
    fake.controls.behavior.holdUndo = true;
    key('z');
    await flushPromises(); // first undo is pending
    key('z'); // second press while the first round trip is in flight
    key('z', { repeat: true }); // key auto-repeat
    await flushPromises();
    expect(undoCalls).toHaveLength(1);
    expect(w.find('[data-test="command-error"]').exists()).toBe(false);
    fake.controls.release();
    await flushPromises();
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Restored');
  });

  it('keeps the notice inert under an overlay and routes its button through the action guards', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await archiveViaKey(w, 'conv-01');
    const opCount = (): number => fake.controls.activity().length;

    // Palette open: the notice is inert exactly like header/main.
    await w.get('[data-test="palette-trigger"]').trigger('click');
    await flushPromises();
    expect(w.get('[data-test="action-notice"]').attributes('inert')).toBeDefined();
    key('Escape');
    await flushPromises();

    // Utility drawer open: the click dispatches the guarded action, not a raw undo.
    await w.get('[data-test="rail-activity"]').trigger('click');
    await flushPromises();
    await w.get('[data-test="action-notice-undo"]').trigger('click');
    await flushPromises();
    expect(opCount()).toBe(1);

    // Drawer closed: the same click undoes.
    await w.get('[data-test="drawer-close"]').trigger('click');
    await flushPromises();
    await w.get('[data-test="action-notice-undo"]').trigger('click');
    await flushPromises();
    expect(opCount()).toBe(2);
  });

  it('hides the Undo control when the refreshed row withdraws eligibility', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    fake.controls.behavior.hold = true;
    await archiveViaKey(w, 'conv-01');
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(true);
    fake.controls.behavior.failNext = 1;
    fake.controls.behavior.failureKind = 'provider_rejected';
    fake.controls.release();
    await flushPromises();
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Failed — restored, see Activity');
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    fake.controls.behavior.hold = false;
  });

  it('never shows the expired wording for a read action that was never undoable', async () => {
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake, { mutationAccess: 'enabled' });
    fake.controls.markReadUnknown('conv-01');
    const w = await mountApp(fake);
    (w.get('[data-test="conversation-row-conv-01"]').element as HTMLElement).focus();
    key('U', { shiftKey: true });
    await flushPromises();
    expect(w.get('[data-test="action-notice-status"]').text()).toBe('Confirmed');
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    expect(w.find('[data-test="action-notice-expired"]').exists()).toBe(false);
  });

  it('expires an unarchive with the Mark Done recovery clause', async () => {
    let offsetMs = 0;
    const fake = createBrowserFakeMailClient(() => new Date(Date.now() + offsetMs).toISOString());
    const w = await mountApp(fake);
    await archiveViaKey(w, 'conv-01');
    // Unarchive from Activity: the notice slot becomes an unarchive action.
    await w.get('[data-test="rail-activity"]').trigger('click');
    await flushPromises();
    await w.get('[data-test="activity-unarchive-op-0001"]').trigger('click');
    await flushPromises();
    // Advance the backend clock past the unarchive window, then refresh.
    offsetMs = 11_000;
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(w.get('[data-test="action-notice-expired"]').text())
      .toBe('Undo expired — Mark Done archives the whole conversation');
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(false);
  });

  it('keeps focus out of the body when the notice Undo button is clicked with a reader open', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await w.get('[data-test="conversation-row-conv-02"]').trigger('click');
    await flushPromises();
    key('e');
    await flushPromises();
    const button = w.get('[data-test="action-notice-undo"]').element as HTMLElement;
    button.focus();
    expect(document.activeElement).toBe(button);
    await w.get('[data-test="action-notice-undo"]').trigger('click');
    await flushPromises();
    // The restored row is behind the still-open reader; focus lands on the
    // reader root instead of dropping to <body> with the removed button.
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement | null)?.closest('[data-test="reader"]')).not.toBeNull();
  });

  it('suppresses Z while a utility drawer is open, for modifiers, and during IME composition', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountApp(fake);
    await archiveViaKey(w, 'conv-01');
    const opCount = (): number => fake.controls.activity().length;
    expect(opCount()).toBe(1);

    // Utility drawer open: shortcuts underneath are suppressed.
    await w.get('[data-test="rail-activity"]').trigger('click');
    await flushPromises();
    key('z');
    await flushPromises();
    expect(opCount()).toBe(1);
    await w.get('[data-test="drawer-close"]').trigger('click');
    await flushPromises();

    (w.get('[data-test="conversation-row-conv-02"]').element as HTMLElement).focus();
    // Cmd/Ctrl+Z stay native.
    key('z', { ctrlKey: true });
    await flushPromises();
    key('z', { metaKey: true });
    await flushPromises();
    expect(opCount()).toBe(1);
    // IME composition never dispatches undo.
    key('z', { isComposing: true });
    await flushPromises();
    key('z', { keyCode: 229 });
    await flushPromises();
    expect(opCount()).toBe(1);
    // Sanity: the plain key still undoes.
    key('z');
    await flushPromises();
    expect(opCount()).toBe(2);
  });

  it('suppresses Z while the narrow contact disclosure is open', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const fake = createBrowserFakeMailClient();
      const w = await mountApp(fake);
      await archiveViaKey(w, 'conv-01');
      const opCount = (): number => fake.controls.activity().length;
      expect(opCount()).toBe(1);
      await w.get('[data-test="contact-disclosure"]').trigger('click');
      await flushPromises();
      expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(true);
      key('z');
      await flushPromises();
      expect(opCount()).toBe(1);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
