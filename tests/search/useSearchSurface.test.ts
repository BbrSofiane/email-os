import { computed, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useSearchSurface } from '../../src/composables/useSearchSurface';
import type { Mailbox } from '../../src/composables/useMailbox';

describe('useSearchSurface', () => {
  it('does not apply the result of a search superseded by navigation', async () => {
    let resolveSearch!: () => void;
    const pending = new Promise<void>((resolve) => { resolveSearch = resolve; });
    const mailbox = {
      conversations: ref([]), context: ref('inbox'), searchQuery: ref(''),
      searchCachedOnly: ref(false), listState: ref('ready'), search: vi.fn(() => pending),
    } as unknown as Mailbox;
    let epoch = 0;
    const focus = vi.fn(async () => {});
    const surface = useSearchSurface({
      mailbox, accountId: computed(() => 'fixture'), accountReady: computed(() => true),
      drawer: ref(null), contactDisclosure: ref(false), replyComposerOpen: ref(false), composeCardOpen: ref(false),
      history: ref([]), captureContext: () => null, releaseEditorSurface: async () => true,
      nextNavigationToken: () => ++epoch, currentNavigationToken: () => epoch, focusFocusedRow: focus,
    });
    const submitted = surface.submitSearch('fixture');
    await Promise.resolve();
    expect(mailbox.search).toHaveBeenCalledOnce();
    epoch++;
    resolveSearch();
    await submitted;
    expect(surface.recentQueries.value).toEqual([]);
    expect(focus).not.toHaveBeenCalled();
  });
});
