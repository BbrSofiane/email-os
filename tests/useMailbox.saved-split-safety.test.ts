import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { useMailbox, type Mailbox } from '../src/composables/useMailbox';
import type { Conversation, InboxSnapshot, MailClient, OperationReceipt, SavedSplit } from '../src/lib/ipc/client';
import { matchesSplit } from '../src/lib/saved-split';
import { createBrowserFakeMailClient, deferred, useGmailMode } from './helpers';

const oldRule: SavedSplit = { name: 'Old senders', criterion: 'sender', value: 'old@example.test', enabled: true, hideWhenEmpty: false };
const newRule: SavedSplit = { ...oldRule, name: 'New senders', value: 'new@example.test' };
const stops: (() => void)[] = [];
afterEach(() => { stops.splice(0).forEach((stop) => stop()); });

/** Controlled read seams, real synthetic details/account/group recovery methods. */
async function setup() {
  const fake = createBrowserFakeMailClient();
  useGmailMode(fake, { mutationAccess: 'enabled' });
  const original = await fake.listConversations();
  let snapshot: InboxSnapshot = {
    ...original,
    conversations: original.conversations.map((row, index) => ({
      ...row,
      primaryCorrespondent: { displayName: null, mailbox: index < 15 ? oldRule.value : newRule.value },
      isRead: index !== 15,
    })),
  };
  let definition: SavedSplit | null = oldRule;
  const lists: ReturnType<typeof deferred<InboxSnapshot>>[] = [];
  const definitions: ReturnType<typeof deferred<SavedSplit | null>>[] = [];
  const details: ReturnType<typeof deferred<Conversation>>[] = [];
  let listener: () => void = () => undefined;
  const archive = vi.fn(fake.setArchived);
  const read = vi.fn(fake.setRead);
  const archiveGroup = vi.fn(fake.setArchivedGroup);
  const readGroup = vi.fn(fake.setReadGroup);
  const client: MailClient = {
    ...fake,
    subscribe: async (callback) => { listener = callback; return () => { listener = () => undefined; }; },
    listConversations: () => lists.shift()?.promise ?? fake.listConversations().then((fresh) => ({ ...snapshot, activity: fresh.activity })),
    getSavedSplit: () => definitions.shift()?.promise ?? Promise.resolve(definition),
    saveSavedSplit: async (_account, split) => { definition = { ...split }; return definition; },
    getConversation: (target) => details.shift()?.promise ?? fake.getConversation(target),
    setArchived: archive,
    setRead: read,
    setArchivedGroup: archiveGroup,
    setReadGroup: readGroup,
  };
  const scope = effectScope();
  stops.push(() => scope.stop());
  const box = scope.run(() => useMailbox(client))!;
  await box.ready;
  await box.setContext('saved');
  return {
    box, fake, client, archive, read, archiveGroup, readGroup,
    get snapshot() { return snapshot; },
    setSnapshot: (next: InboxSnapshot) => { snapshot = next; },
    setDefinition: (next: SavedSplit | null) => { definition = next; },
    emit: () => listener(),
    delayList: () => { const gate = deferred<InboxSnapshot>(); lists.push(gate); return gate; },
    delayDefinition: () => { const gate = deferred<SavedSplit | null>(); definitions.push(gate); return gate; },
    delayDetail: () => { const gate = deferred<Conversation>(); details.push(gate); return gate; },
  };
}

/** A real archived operation, deliberately absent from the saved projection. */
async function activityTarget(h: Awaited<ReturnType<typeof setup>>) {
  const target = h.snapshot.conversations[0]!.ref;
  const archived = await h.fake.setArchived({ conversation: target, archived: true, requestId: 'seed-activity' });
  await h.fake.controls.flush();
  h.setSnapshot({ ...h.snapshot, conversations: h.snapshot.conversations.slice(1) });
  await h.box.refresh();
  expect(h.box.activity.value.some((op) => op.id === archived.operationId)).toBe(true);
  expect(h.box.openRef.value).toBeNull();
  return target;
}

function expectInvalidated(box: Mailbox) {
  expect(box.listState.value).not.toBe('ready');
  expect(box.conversations.value).toEqual([]);
  expect(box.selectedRefs.value).toEqual([]);
  expect(box.selectionInLoadedOrder()).toEqual([]);
  expect(box.rangeAnchorRef.value).toBeNull();
  expect(box.focusedRef.value).toBeNull();
  expect(box.focusedSummary.value).toBeNull();
  expect(box.openRef.value).toBeNull();
  expect(box.conversation.value).toBeNull();
  expect(box.savedTotal.value).toBeNull();
}

function expectAligned(box: Mailbox, snapshot: InboxSnapshot, split: SavedSplit) {
  expect(box.listState.value).toBe('ready');
  expect(box.savedSplit.value).toEqual(split);
  const matching = snapshot.conversations.filter((row) => matchesSplit(row, split));
  expect(box.inboxTotal.value).toBe(snapshot.conversations.length);
  expect(box.savedTotal.value).toBe(matching.length);
  expect(box.conversations.value).toEqual(box.unreadOnly.value ? matching.filter((row) => row.isRead === false) : matching);
}

describe('direct Activity restoration authority', () => {
  it('restores during saved-view invalidation without authorizing stale list or frozen bulk actions', async () => {
    const h = await setup();
    const target = await activityTarget(h);
    const definition = h.delayDefinition();
    const refreshing = h.box.refresh();
    await flushPromises();
    definition.resolve(newRule);
    await refreshing;
    const list = h.delayList();
    const saving = h.box.saveSplit(oldRule);
    await flushPromises();
    expect(h.box.listState.value).toBe('loading');
    // Pending detail for another reader must neither authorize nor redirect recovery.
    const other = h.snapshot.conversations.at(-1)!.ref;
    const detail = h.delayDetail();
    const opening = h.box.openConversationByRef(other, 'activity');
    expect(h.box.detailState.value).toBe('loading');
    const receipt = await h.box.unarchiveFromActivity(target);
    expect(receipt).not.toBeNull();
    expect(h.archive).toHaveBeenCalledTimes(1);
    expect(h.archive.mock.calls[0]![0]).toMatchObject({ conversation: target, archived: false });
    expect((await h.fake.getConversation(target)).isInInbox).toBe(true);
    expect(h.box.openRef.value).toEqual(other);
    expect(await h.box.setArchived(target, false)).toBeNull();
    expect(await h.box.setRead(target, true)).toBeNull();
    expect(await h.box.setArchivedGroup([target], false)).toBe(false);
    expect(await h.box.setReadGroup([target], true)).toBe(false);
    expect(h.archive).toHaveBeenCalledTimes(1);
    list.resolve(h.snapshot);
    await saving;
    detail.resolve(await h.fake.getConversation(other));
    await opening;
    expect(h.box.openRef.value).toEqual(other);
  });

  it('requires a restorable Activity row in the current account, not just any frozen reference', async () => {
    const h = await setup();
    const target = await activityTarget(h);
    expect(await h.box.unarchiveFromActivity(h.snapshot.conversations[0]!.ref)).toBeNull();
    expect(await h.box.unarchiveFromActivity({ ...target, accountId: 'foreign' })).toBeNull();
    h.box.activity.value = h.box.activity.value.map((op) => ({ ...op, status: 'cancelled' }));
    expect(await h.box.unarchiveFromActivity(target)).toBeNull();
    expect(h.archive).not.toHaveBeenCalled();
  });

  it.each(['read_only', 'account-error', 'single-busy', 'group-unresolved'] as const)(
    'keeps the %s mutation gate and existing notice ownership', async (restriction) => {
      const h = await setup();
      const target = await activityTarget(h);
      if (restriction === 'read_only') {
        useGmailMode(h.fake, { mutationAccess: 'read_only' });
        await h.box.refresh();
      } else if (restriction === 'account-error') {
        vi.spyOn(h.client, 'getAccountStatus').mockRejectedValue({ kind: 'storage_unavailable' });
        await h.box.refresh();
      }
      const gate = deferred<OperationReceipt>();
      let pending: Promise<OperationReceipt | null> | undefined;
      if (restriction === 'single-busy') {
        h.archive.mockImplementationOnce(() => gate.promise);
        pending = h.box.unarchiveFromActivity(target);
        expect(h.box.commandInFlight.value).toBe(true);
      } else if (restriction === 'group-unresolved') {
        h.archiveGroup.mockRejectedValueOnce({ kind: 'network_unavailable' });
        await h.box.setArchivedGroup([h.box.conversations.value[0]!.ref], true);
        expect(h.box.bulkUnresolved.value).toBe(true);
      }
      const notice = h.box.lastAction.value;
      const group = h.box.lastGroup.value;
      const calls = h.archive.mock.calls.length;
      expect(await h.box.unarchiveFromActivity(target)).toBeNull();
      expect(h.archive).toHaveBeenCalledTimes(calls);
      expect(h.box.lastAction.value).toEqual(notice);
      expect(h.box.lastGroup.value).toEqual(group);
      expect(h.box.lastCommandError.value?.kind).toBe(restriction === 'read_only' ? 'read_only'
        : restriction === 'account-error' ? 'invalid_request' : 'busy');
      if (pending) {
        gate.reject({ kind: 'storage_unavailable' });
        await pending;
        expect(h.box.commandInFlight.value).toBe(false);
      }
    },
  );

  it('uses the durable setter receipt, fresh request ID, error slot and Undo pipeline', async () => {
    const h = await setup();
    const target = await activityTarget(h);
    h.archive.mockRejectedValueOnce({ kind: 'storage_unavailable' });
    expect(await h.box.unarchiveFromActivity(target)).toBeNull();
    expect(h.box.lastCommandError.value?.kind).toBe('storage_unavailable');
    expect(h.box.lastAction.value).toBeNull();
    expect(await h.box.setArchivedGroup([h.box.conversations.value[0]!.ref], true)).toBe(true);
    expect(h.box.lastGroup.value?.state).toBe('accepted');
    const receipt = await h.box.unarchiveFromActivity(target);
    expect(receipt).not.toBeNull();
    expect(h.archive.mock.calls[0]![0].requestId).not.toBe(h.archive.mock.calls[1]![0].requestId);
    expect(h.box.lastCommandError.value).toBeNull();
    expect(h.box.lastAction.value).toMatchObject({ receipt, actionId: 'unarchive', target });
    expect(h.box.lastGroup.value).toBeNull();
    expect(h.box.lastAction.value?.undoableUntil).not.toBeNull();
    await h.fake.controls.flush();
    expect((await h.fake.getConversation(target)).isInInbox).toBe(true);
    expect(await h.box.undoLastAction()).not.toBeNull();
    await h.fake.controls.flush();
    expect((await h.fake.getConversation(target)).isInInbox).toBe(false);
    expect(h.box.lastAction.value?.undone).not.toBeNull();
  });

  it.each(['receipt', 'error'] as const)('fences a late %s and stale Activity callbacks after account change', async (outcome) => {
    const h = await setup();
    const target = await activityTarget(h);
    const gate = deferred<OperationReceipt>();
    h.archive.mockImplementationOnce(() => gate.promise);
    const oldActivity = [...h.box.activity.value];
    const pending = h.box.unarchiveFromActivity(target);
    const oldStatus = await h.fake.getAccountStatus();
    // Model the native account-scoped read, not fake history carryover.
    vi.spyOn(h.client, 'listConversations').mockResolvedValue({ conversations: [], activity: [] });
    vi.spyOn(h.client, 'getAccountStatus').mockResolvedValue({
      ...oldStatus, account: { ...oldStatus.account!, accountId: 'another-account' },
    });
    await h.box.refresh();
    await flushPromises();
    expect(h.box.accountStatus.value?.account?.accountId).toBe('another-account');
    if (outcome === 'receipt') gate.resolve({ operationId: 'old-account-operation', acceptedAt: '2026-01-01T00:00:00Z' });
    else gate.reject({ kind: 'storage_unavailable' });
    await pending;
    expect(h.box.lastAction.value).toBeNull();
    expect(h.box.lastCommandError.value).toBeNull();
    expect(h.box.commandInFlight.value).toBe(false);
    // Even a retained old-account Activity row cannot authorize the stale callback.
    h.box.activity.value = oldActivity;
    expect(await h.box.unarchiveFromActivity(target)).toBeNull();
    expect(h.archive).toHaveBeenCalledTimes(1);
  });
});

describe('saved split generation/action safety', () => {
  it('invalidates accepted saves immediately; publishes the new rule, rows and totals together', async () => {
    const h = await setup();
    const { box } = h;
    const old = box.conversations.value[0]!.ref;
    box.toggleSelected(old);
    await box.openConversationByRef(old);
    const list = h.delayList();
    const saving = box.saveSplit(newRule);
    await flushPromises();
    expectInvalidated(box);
    expect(box.savedSplit.value).toEqual(oldRule); // never new rule + old rows
    expect(box.splitBusy.value).toBe(true);
    // Even stale DOM callbacks/frozen member arrays cannot resurrect a target.
    box.toggleSelected(old);
    box.focusConversation(old);
    await box.openConversationByRef(old);
    expect(await box.setArchived(old, true)).toBeNull();
    expect(await box.setRead(old, true)).toBeNull();
    expect(await box.setArchivedGroup([old], true)).toBe(false);
    expect(await box.setReadGroup([old], true)).toBe(false);
    expectInvalidated(box);
    expect([h.archive, h.read, h.archiveGroup, h.readGroup].every((fn) => fn.mock.calls.length === 0)).toBe(true);
    list.resolve(h.snapshot);
    expect(await saving).toBe(true);
    expectAligned(box, h.snapshot, newRule);
    expect(box.conversations.value).toHaveLength(3);
    expect(await box.setArchived(old, true)).toBeNull();
    expect(h.archive).not.toHaveBeenCalled();
  });

  it('invalidates background-discovered changes and fences a pending old reader response', async () => {
    const h = await setup();
    const { box } = h;
    const old = box.conversations.value[0]!.ref;
    box.toggleSelected(old);
    await box.openConversationByRef(old);
    const detail = h.delayDetail();
    const definition = h.delayDefinition();
    const list = h.delayList();
    h.setDefinition(newRule);
    h.emit();
    await flushPromises();
    // Until the definition is known, the old published view still owns its targets.
    expect(box.listState.value).toBe('ready');
    expect(box.selectedRefs.value).toEqual([old]);
    definition.resolve(newRule);
    await flushPromises();
    expectInvalidated(box);
    expect(box.savedSplit.value).toEqual(oldRule);
    detail.resolve(await h.fake.getConversation(old));
    await flushPromises();
    expect(box.conversation.value).toBeNull();
    list.resolve(h.snapshot);
    await flushPromises();
    expectAligned(box, h.snapshot, newRule);
    expect(box.selectedRefs.value).toEqual([]);
  });

  it('does not let early Inbox/Activity completion update counts against a delayed definition', async () => {
    const h = await setup();
    const { box } = h;
    const old = box.conversations.value[0]!.ref;
    box.toggleSelected(old);
    const definition = h.delayDefinition();
    h.setSnapshot({ ...h.snapshot, conversations: h.snapshot.conversations.slice(1) });
    const refreshing = box.refresh();
    await flushPromises();
    expect(box.savedSplit.value).toEqual(oldRule);
    expect(box.conversations.value).toHaveLength(15);
    expect(box.savedTotal.value).toBe(15);
    expect(box.inboxTotal.value).toBe(18);
    expect(box.selectedRefs.value).toEqual([old]);
    definition.resolve(newRule);
    await refreshing;
    expectAligned(box, h.snapshot, newRule);
    expect(box.selectedRefs.value).toEqual([]);
  });

  it('preserves usable focus, selection and reader during unchanged-definition refreshes', async () => {
    const h = await setup();
    const { box } = h;
    const old = box.conversations.value[0]!.ref;
    box.toggleSelected(old);
    await box.openConversationByRef(old);
    const list = h.delayList();
    const refreshing = box.refresh();
    await flushPromises();
    expect(box.listState.value).toBe('ready');
    expect(box.focusedRef.value).toEqual(old);
    expect(box.selectedRefs.value).toEqual([old]);
    expect(box.openRef.value).toEqual(old);
    expect(box.detailState.value).toBe('ready');
    list.resolve(h.snapshot);
    await refreshing;
    expectAligned(box, h.snapshot, oldRule);
    expect(box.selectedRefs.value).toEqual([old]);
    expect(box.openRef.value).toEqual(old);
  });

  it.each(['resolve', 'reject'] as const)('fences stale %s responses across an accepted save', async (outcome) => {
    const h = await setup();
    const stale = h.delayList();
    const staleRead = h.box.refresh();
    await flushPromises(); // captured old definition, delayed old snapshot
    const fresh = h.delayList();
    const saving = h.box.saveSplit(newRule);
    await flushPromises();
    expectInvalidated(h.box);
    fresh.resolve(h.snapshot);
    await saving;
    expectAligned(h.box, h.snapshot, newRule);
    if (outcome === 'resolve') stale.resolve({ conversations: [], activity: [] });
    else stale.reject({ kind: 'storage_unavailable' });
    await staleRead;
    expectAligned(h.box, h.snapshot, newRule);
    expect(h.box.listError.value).toBeNull();
  });

  it('leaves changed-rule rows/targets unavailable after a failed list, then recovers atomically', async () => {
    const h = await setup();
    h.box.toggleSelected(h.box.conversations.value[0]!.ref);
    const list = h.delayList();
    h.setDefinition(newRule);
    const refreshing = h.box.refresh();
    await flushPromises();
    expectInvalidated(h.box);
    list.reject({ kind: 'storage_unavailable' });
    await refreshing;
    expectInvalidated(h.box);
    expect(h.box.listState.value).toBe('error');
    expect(h.box.savedSplit.value).toEqual(oldRule);
    expect(h.box.inboxTotal.value).toBeNull();
    await h.box.refresh();
    expectAligned(h.box, h.snapshot, newRule);
  });

  it('does not let a stale definition response invalidate a newer ready generation', async () => {
    const h = await setup();
    const definition = h.delayDefinition();
    const staleRead = h.box.refresh();
    await flushPromises();
    await h.box.saveSplit(newRule);
    const target = h.box.conversations.value[0]!.ref;
    h.box.toggleSelected(target);
    await h.box.openConversationByRef(target);
    definition.resolve(oldRule);
    await staleRead;
    expectAligned(h.box, h.snapshot, newRule);
    expect(h.box.selectedRefs.value).toEqual([target]);
    expect(h.box.openRef.value).toEqual(target);
  });

  it('keeps an accepted save unpublished if its list fails and recovers on retry', async () => {
    const h = await setup();
    const list = h.delayList();
    const saving = h.box.saveSplit(newRule);
    await flushPromises();
    list.reject({ kind: 'storage_unavailable' });
    expect(await saving).toBe(true); // storage committed, refresh did not
    expectInvalidated(h.box);
    expect(h.box.listState.value).toBe('error');
    expect(h.box.savedSplit.value).toEqual(oldRule);
    await h.box.refresh();
    expectAligned(h.box, h.snapshot, newRule);
  });

  it('clears an externally disabled saved view before returning to Inbox', async () => {
    const h = await setup();
    const target = h.box.conversations.value[0]!.ref;
    h.box.toggleSelected(target);
    await h.box.openConversationByRef(target);
    const list = h.delayList();
    h.setDefinition({ ...newRule, enabled: false });
    const refreshing = h.box.refresh();
    await flushPromises();
    expectInvalidated(h.box);
    list.resolve(h.snapshot);
    await refreshing;
    expect(h.box.context.value).toBe('inbox');
    expect(h.box.listState.value).toBe('ready');
    expect(h.box.savedSplit.value?.enabled).toBe(false);
    expect(h.box.conversations.value).toEqual(h.snapshot.conversations);
    expect(h.box.selectedRefs.value).toEqual([]);
    expect(h.box.openRef.value).toBeNull();
  });

  it('keeps total membership independent of unread filtering after editing', async () => {
    const h = await setup();
    await h.box.setUnreadOnly(true);
    await h.box.saveSplit(newRule);
    expectAligned(h.box, h.snapshot, newRule);
    expect(h.box.savedTotal.value).toBe(3);
    expect(h.box.conversations.value).toHaveLength(1);
  });

  it('does not invalidate Inbox selection/reader when saving a different rule', async () => {
    const h = await setup();
    await h.box.setContext('inbox');
    const target = h.box.conversations.value[0]!.ref;
    h.box.toggleSelected(target);
    await h.box.openConversationByRef(target);
    const list = h.delayList();
    const saving = h.box.saveSplit(newRule);
    await flushPromises();
    expect(h.box.listState.value).toBe('ready');
    expect(h.box.selectedRefs.value).toEqual([target]);
    expect(h.box.openRef.value).toEqual(target);
    list.resolve(h.snapshot);
    await saving;
    expect(h.box.savedSplit.value).toEqual(newRule);
    expect(h.box.conversations.value).toEqual(h.snapshot.conversations);
    expect(h.box.savedTotal.value).toBe(3);
    expect(h.box.selectedRefs.value).toEqual([target]);
  });

  it('preserves an explicit Activity reader when a saved definition changes', async () => {
    const h = await setup();
    const activityTarget = h.snapshot.conversations.at(-1)!.ref;
    expect(h.box.conversations.value.some((row) => row.ref.conversationId === activityTarget.conversationId)).toBe(false);
    await h.box.openConversationByRef(activityTarget, 'activity');
    expect(h.box.openRef.value).toEqual(activityTarget);
    const list = h.delayList();
    h.setDefinition(newRule);
    const refreshing = h.box.refresh();
    await flushPromises();
    expect(h.box.listState.value).toBe('loading');
    expect(h.box.conversations.value).toEqual([]);
    expect(h.box.openRef.value).toEqual(activityTarget);
    expect(h.box.detailState.value).toBe('ready');
    list.resolve(h.snapshot);
    await refreshing;
    expectAligned(h.box, h.snapshot, newRule);
    expect(h.box.openRef.value).toEqual(activityTarget);
    h.box.closeReader();
    await h.box.openConversationByRef({ ...activityTarget, accountId: 'foreign' }, 'activity');
    expect(h.box.openRef.value).toBeNull();
  });

  it('publishes Done independently of delayed projection reads, with paired badges later', async () => {
    const h = await setup();
    const definition = h.delayDefinition();
    const list = h.delayList();
    const navigating = h.box.setContext('done');
    await flushPromises();
    expect(h.box.context.value).toBe('done');
    expect(h.box.listState.value).toBe('ready');
    expect(h.box.conversations.value).toEqual([]);
    definition.resolve(newRule);
    await flushPromises();
    expect(h.box.savedSplit.value).toEqual(oldRule);
    list.resolve(h.snapshot);
    await navigating;
    expect(h.box.savedSplit.value).toEqual(newRule);
    expect(h.box.savedTotal.value).toBe(3);
    expect(h.box.listState.value).toBe('ready');
  });
});
