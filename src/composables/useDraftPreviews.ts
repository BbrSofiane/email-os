import { onScopeDispose, ref, watch, type Ref } from 'vue';
import type { DraftRef, DraftSummary } from '../lib/ipc/client';

/** The longest preview kept in memory; the row clips it to one line with an ellipsis. */
const PREVIEW_LIMIT = 240;

/**
 * One line of plain literal text from a draft body: every run of whitespace and
 * control characters becomes one space, the ends are trimmed, and the length is
 * capped. The result is only ever rendered as a text node, never as HTML.
 */
export function previewText(body: string): string {
  return body.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, PREVIEW_LIMIT);
}

interface Entry { revision: number; text: string }

function previewKey(ref: DraftRef): string {
  return `${ref.accountId}:${ref.draftId}`;
}

/**
 * Body previews for the Drafts list. The draft summary has no body, so each
 * body is read once through `load` (an existing local read, `getDraft`) and kept
 * for its revision: a save that bumps the revision reads that draft again, an
 * unchanged draft is never read twice. A failed read shows nothing for that row
 * (no invented text) and is not repeated until the revision changes.
 */
export function useDraftPreviews(
  summaries: () => readonly DraftSummary[],
  load: (ref: DraftRef) => Promise<string>,
) {
  const entries: Ref<Record<string, Entry>> = ref({});
  const requested = new Map<string, number>();
  let disposed = false;

  async function read(summary: DraftSummary): Promise<void> {
    const key = previewKey(summary.ref);
    const revision = summary.revision;
    try {
      const body = await load(summary.ref);
      if (disposed) return;
      entries.value[key] = { revision, text: previewText(body) };
    } catch {
      // Nothing is shown for this row; the next revision tries again.
    }
  }

  watch(summaries, (list) => {
    const keys = new Set(list.map((summary) => previewKey(summary.ref)));
    for (const key of Object.keys(entries.value)) if (!keys.has(key)) delete entries.value[key];
    for (const key of [...requested.keys()]) if (!keys.has(key)) requested.delete(key);
    for (const summary of list) {
      const key = previewKey(summary.ref);
      if (requested.get(key) === summary.revision) continue;
      requested.set(key, summary.revision);
      void read(summary);
    }
  }, { immediate: true });

  onScopeDispose(() => { disposed = true; });

  /** The preview of this draft at its current revision: '' for an empty body, null while unknown. */
  function previewFor(summary: DraftSummary): string | null {
    const entry = entries.value[previewKey(summary.ref)];
    return entry && entry.revision === summary.revision ? entry.text : null;
  }

  return { previewFor };
}
