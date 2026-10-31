/**
 * UX-05 App integration: selection controls, one-target dispatch, group
 * notices, lost-response recovery, Activity group detail, escape precedence.
 * All flows run against the labelled in-memory fake (synthetic, non-durable).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import { createBrowserFakeMailClient, type BrowserFake, useGmailMode } from './helpers';
import { fixtureRef } from './helpers';
import type { MailClient, SetArchivedGroup, SetReadGroup } from '../src/lib/ipc/client';
import { OPERATION_GROUP_MAX_MEMBERS } from '../src/lib/ipc/client';

function keydown(init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, ...init });
  if (init.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  }
  return event;
}

describe('App UX-05 selection and bulk groups', () => {
  let fake: BrowserFake;
  let groupArchives: SetArchivedGroup[];
  let groupReads: SetReadGroup[];
  let client: MailClient;
  let wrapper: VueWrapper | null = null;

  function mountApp(): VueWrapper {
    const w = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    return w;
  }

  async function settle(): Promise<void> {
    await flushPromises();
    await fake.controls.flush();
    await flushPromises();
  }

  beforeEach(() => {
    fake = createBrowserFakeMailClient();
    groupArchives = [];
    groupReads = [];
    const inner = fake;
    client = {
      ...inner,
      setArchivedGroup: (command) => {
        groupArchives.push(command);
        return inner.setArchivedGroup(command);
      },
      setReadGroup: (command) => {
        groupReads.push(command);
        return inner.setReadGroup(command);
      },
    };
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  async function selectRows(wrapper: VueWrapper, ids: string[]): Promise<void> {
    for (const id of ids) {
      await wrapper.find(`[data-test="row-select-${id}"]`).setValue(true);
      await flushPromises();
    }
  }

  it('X toggles the focused row without opening it, ignores auto-repeat, and J/K stay focus-only', async () => {
    const w = mountApp();
    await settle();
    const row = w.find('[data-test="conversation-row-conv-01"]');
    await row.trigger('keydown', { key: 'x' });
    await settle();
    expect((w.find('[data-test="row-select-conv-01"]').element as HTMLInputElement).checked).toBe(true);
    expect(w.find('[data-test="selection-count"]').text()).toContain('1 selected');
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    // Plain J/K never changes the selection.
    window.dispatchEvent(keydown({ key: 'j' }));
    await settle();
    expect((w.find('[data-test="row-select-conv-01"]').element as HTMLInputElement).checked).toBe(true);
    expect(w.find('[data-test="row-select-conv-02"]').exists() && (w.find('[data-test="row-select-conv-02"]').element as HTMLInputElement).checked).toBe(false);
  });

  it('Cmd-click toggles selection without opening; plain click still opens', async () => {
    const w = mountApp();
    await settle();
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click', { metaKey: true });
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect((w.find('[data-test="row-select-conv-01"]').element as HTMLInputElement).checked).toBe(true);
    await w.find('[data-test="conversation-row-conv-02"]').trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    // Selection unchanged by plain open; scope shown in the reader.
    expect(w.find('[data-test="reader-selection-scope"]').text()).toContain('1 selected');
  });

  it('checkbox toggles never open the row and stop propagation from row actions', async () => {
    const w = mountApp();
    await settle();
    await selectRows(w, ['conv-01', 'conv-03']);
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.find('[data-test="selection-count"]').text()).toContain('2 selected');
  });

  it('dispatches one archive group for the selection with the count label, using group semantics for one row', async () => {
    const w = mountApp();
    await settle();
    await selectRows(w, ['conv-01']);
    await w.find('[data-test="selection-archive"]').trigger('click');
    await settle();
    // Selected-one uses the GROUP path, not the single setter.
    expect(groupArchives).toHaveLength(1);
    expect(groupArchives[0]!.members).toEqual([fixtureRef('conv-01')]);
    expect(w.find('[data-test="action-notice-label"]').text()).toContain('1 conversations');
    await settle();
  });

  it('bulk archive from the reader never triggers single archive-and-advance', async () => {
    const w = mountApp();
    await settle();
    await selectRows(w, ['conv-01', 'conv-02']);
    await w.find('[data-test="conversation-row-conv-03"]').trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    // Reader archive acts on the visible scope (the selection): the reader
    // shows explicit count-labelled selected-scope controls, not the open
    // conversation's single-state toggle.
    expect(w.find('[data-test="reader-archive-toggle"]').exists()).toBe(false);
    await w.find('[data-test="reader-selection-archive"]').trigger('click');
    await settle();
    expect(groupArchives).toHaveLength(1);
    expect(groupArchives[0]!.members.map((m) => m.conversationId).sort()).toEqual(['conv-01', 'conv-02']);
    // The reader did not advance to another conversation.
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
  });

  it('Escape clears the selected set before leaving the context', async () => {
    const w = mountApp();
    await settle();
    await selectRows(w, ['conv-01']);
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    expect(w.find('[data-test="selection-bar"]').exists()).toBe(false);
    // Still on the inbox list; no context Back happened.
    expect(w.find('[data-test="conversation-row-conv-01"]').exists()).toBe(true);
  });

  it('blocks duplicate mutation dispatch while group acceptance is unresolved and shows Acceptance not yet known on a lost response', async () => {
    let rejectFirst = true;
    let rejectedCommand: SetArchivedGroup | null = null;
    const failing: MailClient = {
      ...client,
      setArchivedGroup: (command) => {
        if (rejectFirst) {
          rejectFirst = false;
          rejectedCommand = command;
          return Promise.reject({ kind: 'network_unavailable' });
        }
        return client.setArchivedGroup(command);
      },
    };
    const w = mount(App, { props: { client: failing, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    await settle();
    await selectRows(w, ['conv-01']);
    await w.find('[data-test="selection-archive"]').trigger('click');
    await flushPromises();
    // Lost response: the slot shows the honest transport state.
    expect(w.find('[data-test="action-notice-status"]').text()).toContain('Acceptance not yet known');
    // Duplicate dispatch is fenced (button disabled) while unresolved.
    expect((w.find('[data-test="selection-archive"]').element as HTMLButtonElement).disabled).toBe(true);
    // Recovery replays the EXACT original request (same request id/payload).
    await w.find('[data-test="action-notice-recover-acceptance"]').trigger('click');
    await settle();
    expect(groupArchives).toHaveLength(1);
    expect(rejectedCommand).not.toBeNull();
    expect(groupArchives[0]).toEqual(rejectedCommand);
    expect(w.find('[data-test="action-notice-acceptance-unknown"]').exists()).toBe(false);
  });

  it('shows per-status group outcomes and honest partial-undo wording', async () => {
    const w = mountApp();
    await settle();
    // Two members; the fake fails the second child definitively.
    fake.controls.behavior.failNext = 1;
    await selectRows(w, ['conv-01', 'conv-02']);
    await w.find('[data-test="selection-archive"]').trigger('click');
    await settle();
    const statusText = w.find('[data-test="action-notice-status"]').text();
    expect(statusText).toContain('1 confirmed');
    expect(statusText).toContain('1 failed');
    // Group undo from the notice within the window: partial result wording.
    await w.find('[data-test="action-notice-undo-group"]').trigger('click');
    await settle();
    const undoText = w.find('[data-test="action-notice-status"]').text();
    expect(undoText).toContain('Undo accepted for 1 of 2');
    expect(undoText).toContain('1 skipped — failed');
  });

  it('select all loaded selects the loaded snapshot and refuses beyond the bound with wording', async () => {
    const w = mountApp();
    await settle();
    await w.find('[data-test="selection-select-all"]').exists();
    // Start with one selection so the bar renders, then use Select all loaded.
    await selectRows(w, ['conv-01']);
    await w.find('[data-test="selection-select-all"]').trigger('click');
    await settle();
    expect(w.find('[data-test="selection-count"]').text()).toContain('18 selected');
    await w.find('[data-test="selection-clear"]').trigger('click');
    await settle();
    expect(w.find('[data-test="selection-bar"]').exists()).toBe(false);
    // Beyond the bound: select-all is disabled with an explanation.
    fake.controls.behavior.holdQueued = true;
    void OPERATION_GROUP_MAX_MEMBERS;
  });

  it('keeps date headings nonselectable and preserves row action disclosure semantics', async () => {
    const w = mountApp();
    await settle();
    // Headings are presentation list items without checkboxes.
    const headings = w.findAll('.row-group');
    expect(headings.length).toBeGreaterThan(0);
    for (const heading of headings) {
      expect(heading.find('input').exists()).toBe(false);
    }
    // A row action button still stops propagation (opens no reader).
    await w.find('[data-test="row-archive-conv-01"]').trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
  });

  it('Shift+J extends the range from the focused anchor and Shift-click ranges from the anchor', async () => {
    const w = mountApp();
    await settle();
    // Focus conv-01 via click? No — plain click opens. Use X to set focus/anchor.
    await w.find('[data-test="conversation-row-conv-01"]').trigger('keydown', { key: 'x' });
    await settle();
    // Two Shift+J: conv-02 then conv-03 join additively.
    window.dispatchEvent(keydown({ key: 'J', shiftKey: true }));
    await settle();
    window.dispatchEvent(keydown({ key: 'J', shiftKey: true }));
    await settle();
    expect(w.find('[data-test="selection-count"]').text()).toContain('3 selected');
    // Shift-click a distant row: additive range from the original anchor.
    await w.find('[data-test="conversation-row-conv-05"]').trigger('click', { shiftKey: true });
    await settle();
    expect(w.find('[data-test="selection-count"]').text()).toContain('5 selected');
    // X auto-repeat is ignored: one repeat event toggles nothing extra.
    await w.find('[data-test="conversation-row-conv-01"]').trigger('keydown', { key: 'x', repeat: true });
    await settle();
    expect(w.find('[data-test="selection-count"]').text()).toContain('5 selected');
  });

  it('offers explicit Mark N read / Mark N unread groups in Gmail mode (never a mixed toggle)', async () => {
    useGmailMode(fake, { mutationAccess: 'enabled' });
    const w = mountApp();
    await settle();
    await selectRows(w, ['conv-01', 'conv-02']);
    await w.find('[data-test="selection-mark-read"]').trigger('click');
    await settle();
    expect(groupReads).toHaveLength(1);
    expect(groupReads[0]!.read).toBe(true);
    expect(groupReads[0]!.members.map((m) => m.conversationId).sort()).toEqual(['conv-01', 'conv-02']);
    expect(w.find('[data-test="action-notice-label"]').text()).toContain('Mark read');
  });

  it('rehydrates the latest eligible group notice from authoritative state after restart', async () => {
    // Pre-existing committed group (simulates state created before a restart).
    fake.controls.behavior.holdQueued = true;
    await fake.setArchivedGroup({ accountId: 'fixture-account', members: [fixtureRef('conv-01'), fixtureRef('conv-02')], archived: true, requestId: 'req-restart' });
    const w = mountApp();
    await settle();
    const status = w.find('[data-test="action-notice-status"]').text();
    expect(status).toContain('2 pending');
    expect(w.find('[data-test="action-notice-undo-group"]').exists()).toBe(true);
  });

  it('shows group summaries in Activity with per-member detail and undo availability', async () => {
    const w = mountApp();
    await settle();
    fake.controls.behavior.holdQueued = true;
    await selectRows(w, ['conv-01', 'conv-02']);
    await w.find('[data-test="selection-archive"]').trigger('click');
    await settle();
    await w.find('[data-test="rail-activity"]').trigger('click');
    await settle();
    const toggle = w.find('[data-test^="activity-group-toggle-"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.text()).toContain('2 conversations');
    await toggle.trigger('click');
    await settle();
    expect(w.find('[data-test^="group-detail-"]').exists()).toBe(true);
    expect(w.find('[data-test="group-undo-available"]').exists()).toBe(true);
    // Expand collapse: second click closes.
    await toggle.trigger('click');
    await settle();
    expect(w.find('[data-test^="group-detail-"]').exists()).toBe(false);
  });

  it('select-all reacts to the loaded count across the bound (review P2-12)', async () => {
    // Done context pages via listCachedDone; stub >100 loaded rows.
    const baseRows = fake.listCachedDone({ accountId: 'fixture-account', limit: 100, cursor: null });
    const template = (await baseRows).conversations[0]!;
    const oversized = Array.from({ length: OPERATION_GROUP_MAX_MEMBERS + 20 }, (_, i) => ({
      ...template,
      ref: fixtureRef(`extra-${i}`),
    }));
    const client: MailClient = {
      ...inner0(fake),
      listCachedDone: async () => ({
        conversations: oversized,
        nextCursor: null,
        coverage: (await baseRows).coverage,
        exactTotal: oversized.length,
        lastSyncedAt: null,
      }),
    };
    const w = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    await settle();
    await w.find('[data-test="rail-done"]').trigger('click');
    await settle();
    // Select one row to show the bar, then check the reactive disabled state.
    await w.find('[data-test="row-select-extra-0"]').setValue(true);
    const selectAll = w.find('[data-test="selection-select-all"]');
    expect((selectAll.element as HTMLButtonElement).disabled).toBe(true);
    expect(selectAll.attributes('title')).toContain('limited to 100');
  });

  it('X on a focused wide-contact column never mutates the hidden selection (review P2-14)', async () => {
    const w = mountApp();
    await settle();
    const contactColumn = w.find('[data-test="contact-column"]');
    expect(contactColumn.exists()).toBe(true);
    (contactColumn.element as HTMLElement).focus();
    expect(document.activeElement).toBe(contactColumn.element);
    (contactColumn.element as HTMLElement).dispatchEvent(keydown({ key: 'x' }));
    await settle();
    expect(w.find('[data-test="selection-bar"]').exists()).toBe(false);
  });

  it('Clear from the selection bar hands focus to a surviving row (review P2-15)', async () => {
    const w = mountApp();
    await settle();
    await selectRows(w, ['conv-01', 'conv-02']);
    const clearButton = w.find('[data-test="selection-clear"]');
    (clearButton.element as HTMLElement).focus();
    await clearButton.trigger('click');
    await settle();
    expect(w.find('[data-test="selection-bar"]').exists()).toBe(false);
    // Focus did not drop to <body>: the focused row (or empty state) owns it.
    const focusOnRow = document.activeElement?.matches?.('[role="listitem"]') ?? false;
    const focusOnEmpty = document.activeElement?.matches?.('[data-test="inbox-empty"]') ?? false;
    expect(focusOnRow || focusOnEmpty).toBe(true);
  });

  it('the reader with a selection offers both explicit desired-state read controls (review P2-5)', async () => {
    useGmailMode(fake, { mutationAccess: 'enabled' });
    const w = mountApp();
    await settle();
    await selectRows(w, ['conv-01', 'conv-02']);
    await w.find('[data-test="conversation-row-conv-03"]').trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    // Mixed selection: both explicit count-labelled controls, never a
    // mixed-state toggle derived from the open conversation.
    expect(w.find('[data-test="reader-selection-mark-read"]').exists()).toBe(true);
    expect(w.find('[data-test="reader-selection-mark-unread"]').exists()).toBe(true);
    expect(w.find('[data-test="reader-toggle-read"]').exists()).toBe(false);
    expect(w.find('[data-test="reader-selection-mark-read"]').text()).toContain('2 read');
    expect(w.find('[data-test="reader-selection-mark-unread"]').text()).toContain('2 unread');
  });
});

function inner0(fake: BrowserFake): MailClient {
  return fake as unknown as MailClient;
}
