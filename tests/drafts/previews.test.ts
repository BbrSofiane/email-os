/**
 * Draft body previews: one read per revision, nothing invented for a failed
 * read, and no stale read ever replaces the preview of the current revision.
 */
import { effectScope, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { useDraftPreviews } from '../../src/composables/useDraftPreviews';
import type { DraftSummary } from '../../src/lib/ipc/client';
import { deferred } from '../helpers';

const summary = (revision: number): DraftSummary => ({
  ref: { accountId: 'acct', draftId: 'd1' }, revision, updatedAt: '2026-01-02T03:04:00Z', subject: 'Plan', to: 'ada@example.test', source: { kind: 'new_message' },
});

let scope: ReturnType<typeof effectScope> | null = null;
afterEach(() => { scope?.stop(); scope = null; });

function setup(load: Parameters<typeof useDraftPreviews>[1], initial: DraftSummary[]) {
  const list = ref(initial);
  scope = effectScope();
  const previews = scope.run(() => useDraftPreviews(() => list.value, load))!;
  return { list, previews };
}

describe('useDraftPreviews', () => {
  it('reads a body once per revision and shows it as one plain line', async () => {
    const load = vi.fn(async () => 'Hello\n\n  there\t<b>x</b>');
    const { list, previews } = setup(load, [summary(1)]);
    await flushPromises();
    expect(previews.previewFor(summary(1))).toBe('Hello there <b>x</b>');
    list.value = [summary(1)];
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps the current preview when an older read resolves last', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { list, previews } = setup(load, [summary(1)]);
    list.value = [summary(2)];
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(2);
    newer.resolve('current text');
    await flushPromises();
    expect(previews.previewFor(summary(2))).toBe('current text');
    older.resolve('old text');
    await flushPromises();
    expect(previews.previewFor(summary(2))).toBe('current text');
    expect(previews.previewFor(summary(1))).toBeNull();
  });

  it('ignores an older read that resolves before the current one', async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { list, previews } = setup(load, [summary(1)]);
    list.value = [summary(2)];
    await flushPromises();
    older.resolve('old text');
    await flushPromises();
    expect(previews.previewFor(summary(1))).toBeNull();
    expect(previews.previewFor(summary(2))).toBeNull();
    newer.resolve('current text');
    await flushPromises();
    expect(previews.previewFor(summary(2))).toBe('current text');
  });

  it('shows nothing for a failed read and does not repeat it until the revision changes', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValueOnce('later');
    const { list, previews } = setup(load, [summary(1)]);
    await flushPromises();
    expect(previews.previewFor(summary(1))).toBeNull();
    list.value = [summary(1)];
    await flushPromises();
    expect(load).toHaveBeenCalledTimes(1);
    list.value = [summary(2)];
    await flushPromises();
    expect(previews.previewFor(summary(2))).toBe('later');
  });
});
