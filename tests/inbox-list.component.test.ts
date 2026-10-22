import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import InboxList from '../src/components/InboxList.vue';
import type { ConversationRef, ConversationSummary } from '../src/lib/ipc/client';

const ACCOUNT = 'list-account';

function row(
  id: string,
  overrides: Partial<ConversationSummary> & { lastMessageAt: string },
): ConversationSummary {
  return {
    ref: { accountId: ACCOUNT, conversationId: id },
    subject: `Subject ${id}`,
    participants: [{ displayName: 'Someone Else', mailbox: 'other@example.test' }],
    primaryCorrespondent: { displayName: `Sender ${id}`, mailbox: `${id}@example.test` },
    preview: `Preview for ${id}.`,
    pendingOperationId: null,
    ...overrides,
  };
}

const FROZEN_NOW = Date.parse('2026-01-15T12:00:00Z');

describe('InboxList (UX-01 compact rows)', () => {
  let wrapper: VueWrapper | null = null;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.restoreAllMocks();
  });

  function mountList(
    rows: ConversationSummary[],
    focusedRef: ConversationRef | null = null,
    options: { showReadState?: boolean; showReadControls?: boolean; actionsEnabled?: boolean } = {},
  ): VueWrapper {
    const mounted = mount(InboxList, {
      props: { rows, focusedRef, actionsEnabled: true, ...options },
      attachTo: document.body,
    });
    wrapper = mounted;
    return mounted;
  }

  const defaultRows = (): ConversationSummary[] => [
    row('today-1', { lastMessageAt: '2026-01-15T09:00:00Z', isRead: false }),
    row('today-2', { lastMessageAt: '2026-01-15T10:00:00Z', primaryCorrespondent: { displayName: null, mailbox: 'anon@example.test' } }),
    row('yesterday', { lastMessageAt: '2026-01-14T18:00:00Z', isRead: true }),
    row('earlier', { lastMessageAt: '2026-01-02T10:00:00Z', primaryCorrespondent: undefined } as Partial<ConversationSummary> & { lastMessageAt: string }),
    row('december', { lastMessageAt: '2025-12-20T10:00:00Z' }),
  ];

  it('renders group headings in backend order without selectable semantics', async () => {
    const w = mountList(defaultRows(), { accountId: ACCOUNT, conversationId: 'today-1' });
    await flushPromises();
    const headings = w.findAll('.row-group');
    expect(headings.map((h) => h.text())).toEqual(['Today', 'Yesterday', 'Earlier this month', 'December 2025']);
    for (const heading of headings) {
      expect(heading.attributes('role')).toBe('presentation');
      expect((heading.element as HTMLElement).tabIndex).toBe(-1);
      expect(heading.find('button').exists()).toBe(false);
    }
    // Rows keep ordinary list/listitem semantics; focus is aria-current, never aria-selected.
    const rows = w.findAll('[role="listitem"]');
    expect(rows).toHaveLength(5);
    expect(w.findAll('[aria-selected]').length).toBe(0);
    expect(rows[0]!.attributes('aria-current')).toBe('true');
    expect(rows[1]!.attributes('aria-current')).toBeUndefined();
    // Roving tabindex: the focused row is the only tab stop.
    expect((rows[0]!.element as HTMLElement).tabIndex).toBe(0);
    expect((rows[1]!.element as HTMLElement).tabIndex).toBe(-1);
  });

  it('never guesses a sender when primaryCorrespondent is absent', async () => {
    const w = mountList(defaultRows());
    await flushPromises();
    const rows = w.findAll('[role="listitem"]');
    expect(rows[3]!.find('.row-sender').text()).toBe('Unknown sender');
    expect(rows[1]!.find('.row-sender').text()).toBe('anon@example.test');
  });

  it('maps missing and unparsable timestamps to the Unknown date bucket', async () => {
    const w = mountList([
      row('broken', { lastMessageAt: 'not-a-timestamp' }),
      row('missing', { lastMessageAt: '' }),
    ]);
    await flushPromises();
    expect(w.findAll('.row-group').map((h) => h.text())).toEqual(['Unknown date']);
    expect(w.text()).toContain('Unknown');
  });

  it('emits reference-valued focus/open events and keeps inline actions row-scoped', async () => {
    const w = mountList(defaultRows(), { accountId: ACCOUNT, conversationId: 'today-1' });
    await flushPromises();
    const rows = w.findAll('[role="listitem"]');

    await rows[2]!.trigger('focusin');
    expect(w.emitted('focus')).toEqual([[{ accountId: ACCOUNT, conversationId: 'yesterday' }]]);

    await rows[2]!.trigger('click');
    expect(w.emitted('open')).toEqual([[{ accountId: ACCOUNT, conversationId: 'yesterday' }]]);

    // The inline archive button stops propagation: no open, exactly one archive.
    await rows[2]!.find('[data-test="row-archive-yesterday"]').trigger('click');
    expect(w.emitted('archive')).toEqual([[{ accountId: ACCOUNT, conversationId: 'yesterday' }]]);
    expect(w.emitted('open')).toHaveLength(1);

    // Focusing an inline button must not reopen the row; once the row already
    // owns the conversation focus (as in the App integration), no new focus
    // event is emitted and nothing scrolls.
    await w.setProps({ focusedRef: { accountId: ACCOUNT, conversationId: 'yesterday' } });
    await rows[2]!.find('[data-test="row-archive-yesterday"]').trigger('focusin');
    expect(w.emitted('open')).toHaveLength(1);
    expect(w.emitted('focus')).toHaveLength(1);
  });

  it('keeps row DOM identity stable across reordering and insertion', async () => {
    const w = mountList(defaultRows(), { accountId: ACCOUNT, conversationId: 'yesterday' });
    await flushPromises();
    const before = w.find('[data-test="conversation-row-yesterday"]').element as HTMLElement;
    before.focus();
    expect(document.activeElement).toBe(before);

    // A newer conversation is inserted at the top; the focused element survives.
    await w.setProps({ rows: [row('newest', { lastMessageAt: '2026-01-15T11:30:00Z' }), ...defaultRows()] });
    await flushPromises();
    const after = w.find('[data-test="conversation-row-yesterday"]').element as HTMLElement;
    expect(after).toBe(before);
    expect(document.activeElement).toBe(after);
  });

  it('exposes reference-based focusing and scroll-anchor capture/restoration', async () => {
    const w = mountList(defaultRows(), { accountId: ACCOUNT, conversationId: 'today-1' });
    await flushPromises();
    const list = w.vm as unknown as {
      focusRef(ref: ConversationRef, options?: { preventScroll?: boolean }): void;
      captureAnchor(): { ref: ConversationRef; offsetTop: number; scrollTop: number } | null;
      restoreAnchor(anchor: { ref: ConversationRef; offsetTop: number; scrollTop: number }): Promise<void>;
    };

    list.focusRef({ accountId: ACCOUNT, conversationId: 'december' });
    await flushPromises();
    expect(document.activeElement?.getAttribute('data-test')).toBe('conversation-row-december');
    expect(w.emitted('focus')).toEqual([[{ accountId: ACCOUNT, conversationId: 'december' }]]);

    // The row holding DOM focus is the anchor; jsdom geometry is flat zeros,
    // so the anchor carries the ref plus scrollTop fallbacks.
    const anchor = list.captureAnchor();
    expect(anchor).not.toBeNull();
    expect(anchor!.ref).toEqual({ accountId: ACCOUNT, conversationId: 'december' });
    await list.restoreAnchor(anchor!);
    expect((w.find('ul').element as HTMLElement).scrollTop).toBe(0);

    // Without DOM focus inside the list, the focused reference is the anchor.
    (document.activeElement as HTMLElement).blur();
    const fallback = list.captureAnchor();
    expect(fallback!.ref).toEqual({ accountId: ACCOUNT, conversationId: 'today-1' });
  });

  it('keeps compact pending and read-state indicators visible to keyboard and AT users', async () => {
    const rows = defaultRows();
    rows[0]!.pendingOperationId = 'op-1';
    rows[0]!.isRead = undefined;
    const w = mountList(rows, { accountId: ACCOUNT, conversationId: 'today-1' }, { showReadState: true, showReadControls: true });
    await flushPromises();
    expect(w.find('[data-test="row-pending"]').exists()).toBe(true);
    expect(w.find('[data-test="row-pending"]').attributes('role')).toBe('status');
    // Compact visible label; the full disclosure stays in the accessible name.
    expect(w.find('[data-test="row-read-unknown"]').text()).toBe('Unknown');
    expect(w.find('[data-test="row-read-unknown"]').attributes('aria-label')).toBe('Read state unknown');
    expect(w.find('[data-test="row-mark-read-today-1"]').exists()).toBe(true);
    expect(w.find('[data-test="row-mark-unread-today-1"]').exists()).toBe(true);
    expect(w.find('[data-test="row-mark-read-today-1"]').attributes('aria-label')).toBe('Mark read');
    expect(w.find('[data-test="row-mark-unread-today-1"]').attributes('aria-label')).toBe('Mark unread');
  });

  it('collapses row actions behind a named disclosure control without opening the row', async () => {
    const rows = defaultRows();
    rows[0]!.isRead = undefined;
    rows[0]!.pendingOperationId = 'op-1';
    const w = mountList(rows, { accountId: ACCOUNT, conversationId: 'today-1' }, { showReadState: true, showReadControls: true });
    await flushPromises();
    const toggle = w.find('[data-test="row-actions-toggle-today-1"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.attributes('aria-label')).toBe('More actions');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    expect(toggle.attributes('aria-controls')).toBe('row-actions-list-account-today-1');
    expect(w.find('#row-actions-list-account-today-1').exists()).toBe(true);

    // Operating the disclosure never opens the row (propagation stays stopped).
    await toggle.trigger('click');
    expect(w.emitted('open')).toBeUndefined();
    expect(w.find('[data-test="row-actions-toggle-today-1"]').attributes('aria-expanded')).toBe('true');

    // Escape closes locally and returns focus to the disclosure control.
    await w.find('[data-test="conversation-row-today-1"]').trigger('keydown', { key: 'Escape' });
    expect(w.find('[data-test="row-actions-toggle-today-1"]').attributes('aria-expanded')).toBe('false');
    expect(document.activeElement?.getAttribute('data-test')).toBe('row-actions-toggle-today-1');
  });

  it('keeps disclosed row actions reference-valued and row-scoped', async () => {
    const rows = defaultRows();
    rows[0]!.isRead = undefined;
    const w = mountList(rows, null, { showReadControls: true });
    await flushPromises();
    await w.find('[data-test="row-actions-toggle-today-1"]').trigger('click');
    await w.find('[data-test="row-mark-read-today-1"]').trigger('click');
    expect(w.emitted('setRead')).toEqual([[{ accountId: ACCOUNT, conversationId: 'today-1' }, true]]);
    expect(w.emitted('open')).toBeUndefined();
    await w.find('[data-test="row-archive-today-1"]').trigger('click');
    expect(w.emitted('archive')).toEqual([[{ accountId: ACCOUNT, conversationId: 'today-1' }]]);
    expect(w.emitted('open')).toBeUndefined();
  });

  it('closes the row action disclosure when focus leaves the row', async () => {
    const w = mountList(defaultRows(), null);
    await flushPromises();
    await w.find('[data-test="row-actions-toggle-today-1"]').trigger('click');
    expect(w.find('[data-test="row-actions-toggle-today-1"]').attributes('aria-expanded')).toBe('true');
    // Move DOM focus to another row, then let the row observe the focusout.
    (w.find('[data-test="conversation-row-yesterday"]').element as HTMLElement).focus();
    await w.find('[data-test="conversation-row-today-1"]').trigger('focusout');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
    expect(w.find('[data-test="row-actions-toggle-today-1"]').attributes('aria-expanded')).toBe('false');
  });

  it('omits the action disclosure when a row has no actions', async () => {
    const w = mountList(defaultRows(), null, { actionsEnabled: false });
    await flushPromises();
    expect(w.find('[data-test="row-actions-toggle-today-1"]').exists()).toBe(false);
    expect(w.find('.row-actions').exists()).toBe(false);
  });
});
