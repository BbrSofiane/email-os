/**
 * `useDrafts` list-side behaviour: `discardListed` (the Drafts list's revision-checked
 * delete, which never touches the editor) and `openDraft`'s `stillWanted` withdrawal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, defineComponent, h } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { useDrafts } from '../../src/composables/useDrafts';
import type { DraftSummary, MailClient } from '../../src/lib/ipc/client';
import { createBrowserFakeMailClient, deferred, type BrowserFake } from '../helpers';

type Drafts = ReturnType<typeof useDrafts>;
let host: VueWrapper | null = null;
afterEach(() => { host?.unmount(); host = null; });

async function setup(client: MailClient, account: string | null = 'fixture-account'): Promise<Drafts> {
  let drafts!: Drafts;
  host = mount(defineComponent({
    setup() {
      drafts = useDrafts(client, computed(() => account), 'browser-preview');
      return () => h('div');
    },
  }));
  await flushPromises();
  return drafts;
}
async function seed(fake: BrowserFake): Promise<DraftSummary> {
  await fake.createDraft({ requestId: 'seed-1', source: { kind: 'new_message' }, initialContent: { to: 'a@example.test', cc: '', subject: 'One', bodyText: 'body' } });
  return (await fake.listDrafts())[0]!;
}

describe('discardListed', () => {
  it('sends a revision-checked delete with the list request id and refreshes the list before it resolves', async () => {
    const fake = createBrowserFakeMailClient();
    const summary = await seed(fake);
    const deleteDraft = vi.fn(fake.deleteDraft.bind(fake));
    const drafts = await setup({ ...fake, deleteDraft });
    expect(drafts.summaries.value).toHaveLength(1);
    await expect(drafts.discardListed(summary, 'req-1')).resolves.toBeNull();
    expect(deleteDraft).toHaveBeenCalledTimes(1);
    expect(deleteDraft).toHaveBeenCalledWith({ ref: summary.ref, expectedRevision: summary.revision, requestId: 'req-1' });
    expect(drafts.summaries.value).toHaveLength(0);
    expect(await fake.listDrafts()).toHaveLength(0);
  });

  it('returns the error and keeps the draft when the revision is stale', async () => {
    const fake = createBrowserFakeMailClient();
    const summary = await seed(fake);
    const drafts = await setup(fake);
    await fake.saveDraft({ ref: summary.ref, expectedRevision: summary.revision, requestId: 'bump', content: { to: 'a@example.test', cc: '', subject: 'One', bodyText: 'newer' } });
    const result = await drafts.discardListed(summary, 'req-stale');
    expect(result).toMatchObject({ kind: 'draft_conflict' });
    expect(await fake.listDrafts()).toHaveLength(1);
  });

  it('repeats the same request id for a retry and keeps the draft on a transport failure', async () => {
    const fake = createBrowserFakeMailClient();
    const summary = await seed(fake);
    const deleteDraft = vi.fn().mockRejectedValue({ kind: 'storage_unavailable' });
    const drafts = await setup({ ...fake, deleteDraft });
    expect(await drafts.discardListed(summary, 'req-keep')).toEqual({ kind: 'storage_unavailable' });
    expect(await drafts.discardListed(summary, 'req-keep')).toEqual({ kind: 'storage_unavailable' });
    expect(deleteDraft.mock.calls.map(([command]) => command.requestId)).toEqual(['req-keep', 'req-keep']);
    expect(drafts.summaries.value).toHaveLength(1);
  });

  it('refuses a draft that is open in the editor, without calling the client', async () => {
    const fake = createBrowserFakeMailClient();
    const summary = await seed(fake);
    const deleteDraft = vi.fn(fake.deleteDraft.bind(fake));
    const drafts = await setup({ ...fake, deleteDraft });
    expect(await drafts.openDraft(summary.ref)).toBe(true);
    expect(await drafts.discardListed(summary, 'req-open')).toEqual({ kind: 'busy' });
    expect(deleteDraft).not.toHaveBeenCalled();
    expect(drafts.activeRef.value).toEqual(summary.ref);
    expect(await fake.listDrafts()).toHaveLength(1);
  });

  it('refuses a draft of another account, without calling the client', async () => {
    const fake = createBrowserFakeMailClient();
    const summary = await seed(fake);
    const deleteDraft = vi.fn(fake.deleteDraft.bind(fake));
    const drafts = await setup({ ...fake, deleteDraft }, 'another-account');
    expect(await drafts.discardListed(summary, 'req-acct')).toEqual({ kind: 'auth_required' });
    expect(deleteDraft).not.toHaveBeenCalled();
  });
});

describe('Open and Discard of one draft exclude each other', () => {
  it('refuses a discard of a draft whose open is pending, without calling the client, and opens it afterwards', async () => {
    const fake = createBrowserFakeMailClient();
    const summary = await seed(fake);
    const pending = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
    const deleteDraft = vi.fn(fake.deleteDraft.bind(fake));
    const drafts = await setup({ ...fake, deleteDraft, getDraft: () => pending.promise });
    const opening = drafts.openDraft(summary.ref);
    await flushPromises();
    expect(drafts.openingRefs.value.map((claim) => claim.ref)).toEqual([summary.ref]);
    expect(await drafts.discardListed(summary, 'req-opening')).toEqual({ kind: 'busy' });
    expect(deleteDraft).not.toHaveBeenCalled();
    pending.resolve(await fake.getDraft(summary.ref));
    expect(await opening).toBe(true);
    expect(drafts.activeRef.value).toEqual(summary.ref);
    expect(drafts.openingRefs.value).toEqual([]);
    expect(await fake.listDrafts()).toHaveLength(1);
  });

  it('refuses to open a draft whose list delete is in flight, without calling getDraft', async () => {
    const fake = createBrowserFakeMailClient();
    const summary = await seed(fake);
    const pending = deferred<void>();
    const getDraft = vi.fn(fake.getDraft.bind(fake));
    const deleteDraft: MailClient['deleteDraft'] = async (command) => { await pending.promise; return fake.deleteDraft(command); };
    const drafts = await setup({ ...fake, deleteDraft, getDraft });
    const discarding = drafts.discardListed(summary, 'req-flight');
    await flushPromises();
    expect(drafts.discardingRefs.value.map((claim) => claim.ref)).toEqual([summary.ref]);
    expect(await drafts.openDraft(summary.ref)).toBe(false);
    expect(getDraft).not.toHaveBeenCalled();
    expect(drafts.activeRef.value).toBeNull();
    expect(drafts.openingRefs.value).toEqual([]);
    pending.resolve();
    expect(await discarding).toBeNull();
    expect(drafts.discardingRefs.value).toEqual([]);
    expect(await fake.listDrafts()).toHaveLength(0);
  });

  it('releases both claims after a failed open and a failed delete, so the draft can be opened and discarded again', async () => {
    const fake = createBrowserFakeMailClient();
    const summary = await seed(fake);
    const getDraft = vi.fn().mockRejectedValueOnce({ kind: 'storage_unavailable' }).mockImplementation(fake.getDraft.bind(fake));
    const deleteDraft = vi.fn().mockRejectedValueOnce({ kind: 'storage_unavailable' }).mockImplementation(fake.deleteDraft.bind(fake));
    const drafts = await setup({ ...fake, getDraft, deleteDraft });
    expect(await drafts.openDraft(summary.ref)).toBe(false);
    expect(drafts.openingRefs.value).toEqual([]);
    expect(await drafts.discardListed(summary, 'req-fail')).toEqual({ kind: 'storage_unavailable' });
    expect(drafts.discardingRefs.value).toEqual([]);
    expect(await drafts.discardListed(summary, 'req-fail')).toBeNull();
  });

  it('does not block another draft', async () => {
    const fake = createBrowserFakeMailClient();
    const first = await seed(fake);
    await fake.createDraft({ requestId: 'seed-2', source: { kind: 'new_message' }, initialContent: { to: 'b@example.test', cc: '', subject: 'Two', bodyText: 'body' } });
    const second = (await fake.listDrafts()).find((draft) => draft.ref.draftId !== first.ref.draftId)!;
    const pending = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
    const drafts = await setup({ ...fake, getDraft: (ref) => ref.draftId === first.ref.draftId ? pending.promise : fake.getDraft(ref) });
    const opening = drafts.openDraft(first.ref);
    await flushPromises();
    expect(await drafts.discardListed(second, 'req-other')).toBeNull();
    pending.resolve(await fake.getDraft(first.ref));
    expect(await opening).toBe(true);
  });
});

describe('openDraft withdrawal', () => {
  it('does not install a draft that is no longer wanted when getDraft resolves, and sets no error', async () => {
    const fake = createBrowserFakeMailClient();
    const summary = await seed(fake);
    const pending = deferred<Awaited<ReturnType<MailClient['getDraft']>>>();
    const drafts = await setup({ ...fake, getDraft: () => pending.promise });
    let wanted = true;
    const opening = drafts.openDraft(summary.ref, () => wanted);
    await flushPromises();
    wanted = false;
    pending.resolve(await fake.getDraft(summary.ref));
    expect(await opening).toBe(false);
    expect(drafts.activeRef.value).toBeNull();
    expect(drafts.isVisible.value).toBe(false);
    expect(drafts.createError.value).toBeNull();
  });

  it('sets no error for a withdrawn open whose getDraft fails, but still reports a wanted failure', async () => {
    const fake = createBrowserFakeMailClient();
    const summary = await seed(fake);
    const failing = (): Promise<never> => Promise.reject({ kind: 'not_found' });
    const drafts = await setup({ ...fake, getDraft: failing });
    expect(await drafts.openDraft(summary.ref, () => false)).toBe(false);
    expect(drafts.createError.value).toBeNull();
    expect(await drafts.openDraft(summary.ref)).toBe(false);
    expect(drafts.createError.value).toEqual({ kind: 'not_found' });
  });
});
