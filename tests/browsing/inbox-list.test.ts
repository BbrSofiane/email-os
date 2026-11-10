import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import InboxList from '../../src/components/InboxList.vue';
import type { ConversationRef, ConversationSummary } from '../../src/lib/ipc/client';

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
    options: { showReadState?: boolean; showReadControls?: boolean; actionsEnabled?: boolean; context?: 'inbox' | 'saved' | 'done' | 'starred' | 'search'; searchQuery?: string } = {},
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
    // A leading Today caption stays for assistive technology only: today's
    // rows already show a time, and the first row keeps the first list line.
    expect(headings.map((h) => h.classes().includes('visually-hidden'))).toEqual([true, false, false, false]);
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

  it('removes the star indicator entirely when a starred row becomes known unstarred', async () => {
    const sample = row('star', {
      lastMessageAt: '2026-01-15T09:00:00Z',
      stars: { starredMessages: 1, knownMessages: 1, totalMessages: 2 },
    });
    const w = mountList([sample]);
    expect(w.get('[data-test="row-stars"]').text()).toBe('★ (partial)');
    expect(w.get('[data-test="row-stars"]').attributes('aria-label')).toContain('Starred');
    await w.setProps({ rows: [{ ...sample, stars: { starredMessages: 0, knownMessages: 2, totalMessages: 2 } }] });
    expect(w.find('[data-test="row-stars"]').exists()).toBe(false);
    expect(w.text()).not.toContain('☆');
  });

  it('keeps unknown star coverage visible rather than treating it as unstarred', async () => {
    const sample = row('unknown-star', { lastMessageAt: '2026-01-15T09:00:00Z' });
    const w = mountList([sample]);
    for (const stars of [
      { starredMessages: 0, knownMessages: 0, totalMessages: 1 },
      { starredMessages: 0, knownMessages: 1, totalMessages: 2 },
      { starredMessages: 0, knownMessages: 0, totalMessages: 0 },
    ]) {
      await w.setProps({ rows: [{ ...sample, stars }] });
      expect(w.get('[data-test="row-stars"]').text()).toContain('Star unknown');
      expect(w.get('[data-test="row-stars"]').attributes('aria-label')).toContain('Star state unknown');
    }
  });

  it('never guesses a sender when primaryCorrespondent is absent', async () => {
    const w = mountList(defaultRows());
    await flushPromises();
    const rows = w.findAll('[role="listitem"]');
    expect(rows[3]!.find('.row-sender').text()).toBe('Unknown sender');
    expect(rows[1]!.find('.row-sender').text()).toBe('anon@example.test');
  });

  it('keeps a leading caption other than Today visible, so the list says where it starts', async () => {
    const w = mountList(defaultRows().slice(2));
    await flushPromises();
    const headings = w.findAll('.row-group');
    expect(headings.map((h) => h.text())).toEqual(['Yesterday', 'Earlier this month', 'December 2025']);
    expect(headings.some((h) => h.classes().includes('visually-hidden'))).toBe(false);
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
    // Gutter marker glyph (hollow ring); the exact state is its accessible name.
    const unknownMarker = w.find('[data-test="row-read-unknown"]');
    expect(unknownMarker.attributes('role')).toBe('img');
    expect(unknownMarker.attributes('aria-label')).toBe('Read state unknown');
    expect(unknownMarker.attributes('title')).toBe('Read state unknown');
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

  it('names every read state in the gutter marker and only de-emphasizes known-read rows', async () => {
    const w = mountList(defaultRows(), null, { showReadState: true });
    await flushPromises();
    const marker = (id: string) => w.get(`[data-test="conversation-row-${id}"] .row-read-state`);
    expect(marker('today-1').attributes('data-test')).toBe('row-unread');
    expect(marker('today-1').attributes('aria-label')).toBe('Unread');
    expect(marker('yesterday').attributes('data-test')).toBe('row-read');
    expect(marker('yesterday').attributes('aria-label')).toBe('Read');
    expect(marker('today-2').attributes('data-test')).toBe('row-read-unknown');
    expect(marker('today-2').attributes('aria-label')).toBe('Read state unknown');
    // No text label competes with the subject; the state is never silent.
    for (const id of ['today-1', 'yesterday', 'today-2']) expect(marker(id).text()).toBe('');
    expect(w.get('[data-test="conversation-row-yesterday"]').classes()).toContain('is-read');
    expect(w.get('[data-test="conversation-row-today-1"]').classes()).not.toContain('is-read');
    expect(w.get('[data-test="conversation-row-today-2"]').classes()).not.toContain('is-read');

    // Where read facts are not disclosed, neither the marker nor the weight cue renders.
    await w.setProps({ showReadState: false });
    expect(w.find('.row-read-state').exists()).toBe(false);
    expect(w.get('[data-test="conversation-row-yesterday"]').classes()).not.toContain('read-disclosed');
  });

  it('keeps icon-only row actions named and moves inner Tab stops with the roving row', async () => {
    const rows = defaultRows();
    const w = mountList(rows, { accountId: ACCOUNT, conversationId: 'yesterday' }, { showReadState: true, showReadControls: true });
    await flushPromises();
    const archive = w.get('[data-test="row-archive-yesterday"]');
    expect(archive.find('svg[aria-hidden="true"]').exists()).toBe(true);
    expect(archive.text()).toBe('Mark done');
    expect(w.get('[data-test="row-toggle-read-yesterday"]').text()).toBe('Mark unread');
    expect(w.get('[data-test="row-toggle-read-today-1"]').text()).toBe('Mark read');
    expect(w.get('[data-test="row-actions-toggle-yesterday"]').attributes('aria-label')).toBe('More actions');

    const tabStops = () => w.findAll('input, button')
      .filter((control) => (control.element as HTMLElement).tabIndex === 0)
      .map((control) => control.attributes('data-test'));
    // Only the focused row's checkbox and actions are in the Tab sequence.
    expect(tabStops()).toEqual([
      'row-select-yesterday',
      'row-actions-toggle-yesterday',
      'row-toggle-read-yesterday',
      'row-archive-yesterday',
    ]);
    // Other rows' controls stay programmatically focusable and operable.
    const otherArchive = w.get('[data-test="row-archive-today-1"]').element as HTMLButtonElement;
    expect(otherArchive.tabIndex).toBe(-1);
    otherArchive.focus();
    expect(document.activeElement).toBe(otherArchive);
    await w.get('[data-test="row-archive-today-1"]').trigger('click');
    expect(w.emitted('archive')).toEqual([[{ accountId: ACCOUNT, conversationId: 'today-1' }]]);
    expect(w.emitted('open')).toBeUndefined();

    // The inner stops follow the focused reference.
    await w.setProps({ focusedRef: { accountId: ACCOUNT, conversationId: 'december' } });
    expect(tabStops()[0]).toBe('row-select-december');
    expect(tabStops().every((id) => id?.endsWith('-december'))).toBe(true);
  });

  it('enters selection mode on the list without conflating selection and focus', async () => {
    const w = mountList(defaultRows(), { accountId: ACCOUNT, conversationId: 'today-1' });
    await flushPromises();
    expect(w.get('ul').classes()).not.toContain('selecting');
    await w.setProps({ selectedRefs: [{ accountId: ACCOUNT, conversationId: 'yesterday' }] });
    expect(w.get('ul').classes()).toContain('selecting');
    const selected = w.get('[data-test="conversation-row-yesterday"]');
    expect(selected.classes()).toContain('selected');
    expect(selected.classes()).not.toContain('focused');
    expect(selected.attributes('aria-current')).toBeUndefined();
    expect((w.get('[data-test="row-select-yesterday"]').element as HTMLInputElement).checked).toBe(true);
    const focused = w.get('[data-test="conversation-row-today-1"]');
    expect(focused.classes()).toContain('focused');
    expect(focused.classes()).not.toContain('selected');
  });

  it('omits the action disclosure when a row has no actions', async () => {
    const w = mountList(defaultRows(), null, { actionsEnabled: false });
    await flushPromises();
    expect(w.find('[data-test="row-actions-toggle-today-1"]').exists()).toBe(false);
    expect(w.find('.row-actions').exists()).toBe(false);
  });

  describe('sender grouping in search results (P5b)', () => {
    const ada = { displayName: 'Ada Fixture', mailbox: 'ada@example.test' };
    const bob = { displayName: 'Bob Fixture', mailbox: 'bob@example.test' };

    // Interleaved senders, all today: date captions would collapse to one
    // hidden Today, so any visible caption here is a sender caption.
    const senderRows = (): ConversationSummary[] => [
      row('s1', { lastMessageAt: '2026-01-15T09:00:00Z', primaryCorrespondent: ada }),
      row('s2', { lastMessageAt: '2026-01-15T10:00:00Z', primaryCorrespondent: bob }),
      row('s3', { lastMessageAt: '2026-01-15T11:00:00Z', primaryCorrespondent: ada }),
      row('s4', { lastMessageAt: '2026-01-15T08:00:00Z', primaryCorrespondent: undefined, participants: [{ displayName: null, mailbox: 'anon@example.test' }] }),
      row('s5', { lastMessageAt: '2026-01-15T07:00:00Z', primaryCorrespondent: undefined, participants: [] }),
      row('s6', { lastMessageAt: '2026-01-15T06:00:00Z', primaryCorrespondent: { displayName: null, mailbox: 'bare@example.test' } }),
    ];

    const mountSearch = (rows: ConversationSummary[], searchQuery: string, focusedRef: ConversationRef | null = null) =>
      mountList(rows, focusedRef, { context: 'search', searchQuery });

    it('renders one "Name (count)" caption per exact sender with date captions nested inside each group, keeping row order inside each group', async () => {
      const w = mountSearch(senderRows(), 'from:"example.test"');
      await flushPromises();
      const headings = w.findAll('.row-group');
      // First-seen group order; counts are per exact sender mailbox; the date
      // caption continues inside each sender group (all rows here are today).
      expect(headings.map((h) => h.text())).toEqual([
        'Ada Fixture (2)', 'Today',
        'Bob Fixture (1)', 'Today',
        'anon@example.test (1)', 'Today',
        'Unknown sender (1)', 'Today',
        'bare@example.test (1)', 'Today',
      ]);
      // Leading-Today rule on the very first caption in the list, whether
      // sender or date: the list opens with today's mail, so the leading
      // sender caption is visually hidden (kept for assistive technology).
      expect(headings.map((h) => h.classes().includes('visually-hidden'))).toEqual([
        true, false, false, false, false, false, false, false, false, false,
      ]);
      // Rows keep backend order inside each group: Ada's rows stay s1, s3.
      expect(w.findAll('[role="listitem"]').map((r) => r.attributes('data-test'))).toEqual([
        'conversation-row-s1',
        'conversation-row-s3',
        'conversation-row-s2',
        'conversation-row-s4',
        'conversation-row-s5',
        'conversation-row-s6',
      ]);
      // Captions use the existing non-actionable group mechanism.
      for (const heading of headings) {
        expect(heading.attributes('role')).toBe('presentation');
        expect((heading.element as HTMLElement).tabIndex).toBe(-1);
        expect(heading.find('button').exists()).toBe(false);
        expect(heading.find('input').exists()).toBe(false);
      }
    });

    it('nests date captions inside a sender group on every bucket change, with the leading rule on the first caption', async () => {
      const rows = [
        row('m1', { lastMessageAt: '2026-01-15T09:00:00Z', primaryCorrespondent: ada }), // today
        row('m2', { lastMessageAt: '2026-01-14T09:00:00Z', primaryCorrespondent: ada }), // yesterday
        row('m3', { lastMessageAt: '2026-01-15T08:00:00Z', primaryCorrespondent: bob }), // today
        row('m4', { lastMessageAt: '2026-01-13T09:00:00Z', primaryCorrespondent: bob }), // earlier this month
      ];
      const w = mountSearch(rows, 'from:"example.test"');
      await flushPromises();
      const headings = w.findAll('.row-group');
      expect(headings.map((h) => h.text())).toEqual([
        'Ada Fixture (2)', 'Today', 'Yesterday',
        'Bob Fixture (2)', 'Today', 'Earlier this month',
      ]);
      // The very first caption (the leading sender caption) is visually
      // hidden because the list opens with today's mail; all others stay visible.
      expect(headings.map((h) => h.classes().includes('visually-hidden'))).toEqual([true, false, false, false, false, false]);
      // Rows keep backend order inside each group.
      expect(w.findAll('[role="listitem"]').map((r) => r.attributes('data-test'))).toEqual([
        'conversation-row-m1', 'conversation-row-m2', 'conversation-row-m3', 'conversation-row-m4',
      ]);
    });

    it('keeps the leading sender caption visible when the list does not open with today', async () => {
      const rows = [
        row('p1', { lastMessageAt: '2026-01-14T09:00:00Z', primaryCorrespondent: ada }),
        row('p2', { lastMessageAt: '2026-01-13T09:00:00Z', primaryCorrespondent: bob }),
      ];
      const w = mountSearch(rows, 'from:"example.test"');
      await flushPromises();
      const headings = w.findAll('.row-group');
      expect(headings.map((h) => h.text())).toEqual([
        'Ada Fixture (1)', 'Yesterday',
        'Bob Fixture (1)', 'Earlier this month',
      ]);
      expect(headings.some((h) => h.classes().includes('visually-hidden'))).toBe(false);
    });

    it.each([
      'subject:fixture',
      'fixture',
      'from:ada@example.test OR from:bob@example.test',
      'from:ada@example.test AND subject:x',
      '-from:ada@example.test',
      'from:ada@example.test -subject:x',
      'from:',
    ])('keeps date captions (no sender captions) for the non-single-from query %j', async (query) => {
      const w = mountSearch(senderRows(), query);
      await flushPromises();
      const headings = w.findAll('.row-group');
      expect(headings.map((h) => h.text())).toEqual(['Today']);
      expect(headings[0]!.classes().includes('visually-hidden')).toBe(true);
      expect(headings.some((h) => /\(\d+\)$/.test(h.text()))).toBe(false);
    });

    it('ignores searchQuery outside the search context', async () => {
      for (const context of ['inbox', 'done', undefined] as const) {
        const w = mountList(senderRows(), null, { context, searchQuery: 'from:"ada@example.test"' });
        await flushPromises();
        const headings = w.findAll('.row-group');
        expect(headings.map((h) => h.text()), String(context)).toEqual(['Today']);
        expect(headings.some((h) => /\(\d+\)$/.test(h.text()))).toBe(false);
      }
    });

    it('keeps focus and navigation on conversation rows only, skipping sender captions', async () => {
      const w = mountSearch(senderRows(), 'from:"example.test"', { accountId: ACCOUNT, conversationId: 's1' });
      await flushPromises();
      const list = w.vm as unknown as { focusRef(ref: ConversationRef): void };
      // focusRef addresses a row in the second sender group, past a caption.
      list.focusRef({ accountId: ACCOUNT, conversationId: 's2' });
      await flushPromises();
      expect(document.activeElement?.getAttribute('data-test')).toBe('conversation-row-s2');
      expect(w.emitted('focus')).toEqual([[{ accountId: ACCOUNT, conversationId: 's2' }]]);
      // The parent applies the emitted focus reference, as App does.
      await w.setProps({ focusedRef: { accountId: ACCOUNT, conversationId: 's2' } });
      // Captions are not focusable: focusing one leaves focus on the row.
      (w.findAll('.row-group')[0]!.element as HTMLElement).focus();
      expect(document.activeElement?.getAttribute('data-test')).toBe('conversation-row-s2');
      // Roving tabindex: only the focused row is the tab stop.
      const rows = w.findAll('[role="listitem"]');
      expect((rows[2]!.element as HTMLElement).tabIndex).toBe(0);
      expect((rows[0]!.element as HTMLElement).tabIndex).toBe(-1);
      expect(rows[0]!.attributes('aria-current')).toBeUndefined();
      expect(rows[2]!.attributes('aria-current')).toBe('true');
    });

    it('keeps selection, open and row actions working under sender captions', async () => {
      const w = mountSearch(senderRows(), 'from:"example.test"', { accountId: ACCOUNT, conversationId: 's1' });
      await w.setProps({ selectedRefs: [{ accountId: ACCOUNT, conversationId: 's3' }] });
      await flushPromises();
      const selected = w.get('[data-test="conversation-row-s3"]');
      expect(selected.classes()).toContain('selected');
      expect((w.get('[data-test="row-select-s3"]').element as HTMLInputElement).checked).toBe(true);
      await w.get('[data-test="row-select-s3"]').trigger('change');
      expect(w.emitted('selectToggle')).toEqual([[{ accountId: ACCOUNT, conversationId: 's3' }]]);
      await w.get('[data-test="conversation-row-s2"]').trigger('click');
      expect(w.emitted('open')).toEqual([[{ accountId: ACCOUNT, conversationId: 's2' }]]);
      await w.get('[data-test="row-archive-s2"]').trigger('click');
      expect(w.emitted('archive')).toEqual([[{ accountId: ACCOUNT, conversationId: 's2' }]]);
      expect(w.emitted('open')).toHaveLength(1);
    });
  });
});

describe('InboxList attachment glyph (P5a truthful indicator)', () => {
  let wrapper: VueWrapper | null = null;

  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.restoreAllMocks();
  });

  function mountList(rows: ConversationSummary[]): VueWrapper {
    const mounted = mount(InboxList, {
      props: { rows, focusedRef: null, actionsEnabled: true },
      attachTo: document.body,
    });
    wrapper = mounted;
    return mounted;
  }

  it('renders the solid paperclip before the date only when hasAttachments is known true', async () => {
    const w = mountList([
      row('with-att', { lastMessageAt: '2026-01-15T09:00:00Z', hasAttachments: true }),
      row('no-att', { lastMessageAt: '2026-01-15T10:00:00Z', hasAttachments: false }),
      row('unknown-att', { lastMessageAt: '2026-01-15T11:00:00Z' }),
    ]);
    await flushPromises();
    const rows = w.findAll('[role="listitem"]');
    expect(rows).toHaveLength(3);
    // Known true: glyph present, with accessible name and tooltip.
    const glyph = rows[0]!.get('[data-test="row-attachment"]');
    expect(glyph.attributes('role')).toBe('img');
    expect(glyph.attributes('aria-label')).toBe('Has attachments');
    expect(glyph.attributes('title')).toBe('Has attachments');
    expect(glyph.find('svg').exists()).toBe(true);
    // It sits before the date inside the row's metadata, and the date stays.
    const metaChildren = rows[0]!.get('.row-meta').element.children;
    const names = Array.from(metaChildren).map((el) => (el as HTMLElement).className);
    expect(names.indexOf('row-attachment')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('row-attachment')).toBeLessThan(names.indexOf('row-trailing'));
    expect(rows[0]!.find('.row-time').exists()).toBe(true);
    // Known false: no glyph at all (no muted "no attachments" marker).
    expect(rows[1]!.find('[data-test="row-attachment"]').exists()).toBe(false);
    expect(rows[1]!.find('[data-test="row-attachment-unknown"]').exists()).toBe(false);
    expect(rows[1]!.find('.row-time').exists()).toBe(true);
    // Unknown (key absent): the outline glyph, not silence (detailed below).
    expect(rows[2]!.find('[data-test="row-attachment"]').exists()).toBe(false);
    expect(rows[2]!.get('[data-test="row-attachment-unknown"]').attributes('aria-label')).toBe('Attachment state unknown');
    expect(rows[2]!.find('.row-time').exists()).toBe(true);
  });

  it('renders the outline paperclip for an unknown attachment state (undefined or absent), before the date', async () => {
    const w = mountList([
      row('explicit-undefined', { lastMessageAt: '2026-01-15T09:00:00Z', hasAttachments: undefined }),
      row('key-absent', { lastMessageAt: '2026-01-15T10:00:00Z' }),
    ]);
    await flushPromises();
    const rows = w.findAll('[role="listitem"]');
    expect(rows).toHaveLength(2);
    for (const rowEl of rows) {
      const glyph = rowEl.get('[data-test="row-attachment-unknown"]');
      expect(glyph.attributes('role')).toBe('img');
      expect(glyph.attributes('aria-label')).toBe('Attachment state unknown');
      expect(glyph.attributes('title')).toBe('Attachment state unknown');
      expect(glyph.classes()).toContain('row-attachment-unknown');
      expect(glyph.find('svg').exists()).toBe(true);
      // No solid glyph in the unknown state.
      expect(rowEl.find('[data-test="row-attachment"]').exists()).toBe(false);
      // Same position as the solid glyph: inside the row's metadata, before
      // the trailing slot (and so before the date), which stays in the DOM.
      const metaChildren = Array.from(rowEl.get('.row-meta').element.children) as HTMLElement[];
      const glyphIndex = metaChildren.findIndex((el) => el.classList.contains('row-attachment-unknown'));
      const trailingIndex = metaChildren.findIndex((el) => el.classList.contains('row-trailing'));
      expect(glyphIndex).toBeGreaterThanOrEqual(0);
      expect(glyphIndex).toBeLessThan(trailingIndex);
      expect(rowEl.find('.row-time').exists()).toBe(true);
    }
  });

  it('flips reactively between solid, unknown and none as hasAttachments changes', async () => {
    const sample = row('flip', { lastMessageAt: '2026-01-15T09:00:00Z' });
    const w = mountList([sample]);
    await flushPromises();
    // Absent key starts in the unknown state.
    expect(w.find('[data-test="row-attachment"]').exists()).toBe(false);
    expect(w.get('[data-test="row-attachment-unknown"]').attributes('aria-label')).toBe('Attachment state unknown');
    // Known true: solid glyph, named, still before the trailing date.
    await w.setProps({ rows: [{ ...sample, hasAttachments: true }] });
    const solid = w.get('[data-test="row-attachment"]');
    expect(solid.attributes('aria-label')).toBe('Has attachments');
    expect(solid.attributes('title')).toBe('Has attachments');
    expect(w.find('[data-test="row-attachment-unknown"]').exists()).toBe(false);
    let metaChildren = Array.from(w.get('.row-meta').element.children) as HTMLElement[];
    expect(metaChildren.findIndex((el) => el.classList.contains('row-attachment'))).toBeLessThan(
      metaChildren.findIndex((el) => el.classList.contains('row-trailing')),
    );
    // Known false: no glyph at all.
    await w.setProps({ rows: [{ ...sample, hasAttachments: false }] });
    expect(w.find('[data-test="row-attachment"]').exists()).toBe(false);
    expect(w.find('[data-test="row-attachment-unknown"]').exists()).toBe(false);
    expect(w.find('.row-time').exists()).toBe(true);
    // Back to unknown: the outline glyph returns in the same position.
    await w.setProps({ rows: [{ ...sample, hasAttachments: undefined }] });
    expect(w.find('[data-test="row-attachment"]').exists()).toBe(false);
    const unknown = w.get('[data-test="row-attachment-unknown"]');
    expect(unknown.attributes('aria-label')).toBe('Attachment state unknown');
    metaChildren = Array.from(w.get('.row-meta').element.children) as HTMLElement[];
    expect(metaChildren.findIndex((el) => el.classList.contains('row-attachment-unknown'))).toBeLessThan(
      metaChildren.findIndex((el) => el.classList.contains('row-trailing')),
    );
  });

  it('updates the glyph when the row fact changes', async () => {
    const sample = row('flip', { lastMessageAt: '2026-01-15T09:00:00Z' });
    const w = mountList([sample]);
    await flushPromises();
    expect(w.find('[data-test="row-attachment"]').exists()).toBe(false);
    await w.setProps({ rows: [{ ...sample, hasAttachments: true }] });
    expect(w.get('[data-test="row-attachment"]').attributes('aria-label')).toBe('Has attachments');
    await w.setProps({ rows: [{ ...sample, hasAttachments: false }] });
    expect(w.find('[data-test="row-attachment"]').exists()).toBe(false);
  });
});
