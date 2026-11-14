/**
 * The search surface (UX-07), moved out of App.vue: the entry form state, the
 * session-only recent queries, suggestions (recent queries and cached
 * correspondents), the inline grammar error, submit/reveal and the input's key
 * handling. Recent queries live in memory for this instance only; nothing is
 * persisted. Whatever the surface touches in the shell (drawer, contact
 * disclosure, composers, history, focus) arrives as an argument, and the
 * shell's navigation token is read through two functions so a newer navigation
 * still supersedes a search in flight.
 */
import { computed, nextTick, ref, watch, type ComputedRef, type Ref } from 'vue';
import { validateSearch } from '../lib/search';
import type { Mailbox } from './useMailbox';

export interface SearchSuggestion { kind: 'query' | 'correspondent'; label: string; detail: string; value: string }

export interface SearchSurfaceDeps {
  mailbox: Mailbox;
  accountId: ComputedRef<string | null>;
  accountReady: ComputedRef<boolean>;
  /** Utility drawer, narrow contact disclosure and the two draft surfaces that cover the central pane. */
  drawer: Ref<string | null>;
  contactDisclosure: Ref<boolean>;
  replyComposerOpen: Ref<boolean>;
  composeCardOpen: Ref<boolean>;
  /** Context history: entering Search from another context pushes the context it left. */
  history: Ref<unknown[]>;
  captureContext: () => unknown;
  /** Protected close of the active editor surface; false keeps the reader and composer. */
  releaseEditorSurface: () => Promise<boolean>;
  /** The shell's navigation epoch: a newer navigation supersedes a search in flight. */
  nextNavigationToken: () => number;
  currentNavigationToken: () => number;
  focusFocusedRow: (preventScroll?: boolean) => Promise<void>;
}

export function useSearchSurface({ mailbox, accountId, accountReady, drawer, contactDisclosure, replyComposerOpen, composeCardOpen, history, captureContext, releaseEditorSurface, nextNavigationToken, currentNavigationToken, focusFocusedRow }: SearchSurfaceDeps) {
  const searchVisible = ref(false);
  const searchDraft = ref('');
  const searchInput = ref<HTMLInputElement | null>(null);
  const cachedSearch = ref(false);
  // Session-only by design: recently submitted queries live in memory for this
  // app instance and account only — never persisted to disk, localStorage or
  // the provider. Recorded on successful submitSearch only.
  const recentQueries = ref<string[]>([]);
  const RECENT_QUERY_LIMIT = 8;
  const CORRESPONDENT_LIMIT = 6;
  const suggestionsOpen = ref(false);
  const suggestionIndex = ref(-1);
  const searchAttemptedEmpty = ref(false);
  const suggestionsId = 'mail-query-suggestions';
  const suggestionId = (index: number) => `mail-query-suggestion-${index}`;
  // Cached correspondent name/address pairs derived from the currently loaded
  // conversations' senders/recipients, bounded so a long list stays cheap.
  const cachedCorrespondents = computed(() => {
    const seen = new Map<string, { displayName: string | null; mailbox: string }>();
    for (const row of mailbox.conversations.value.slice(0, 100)) {
      const people = row.primaryCorrespondent ? [row.primaryCorrespondent, ...row.participants] : row.participants;
      for (const person of people) if (person.mailbox) seen.set(person.mailbox.toLowerCase(), person);
    }
    return [...seen.values()];
  });
  const searchSuggestions = computed<SearchSuggestion[]>(() => {
    const input = searchDraft.value.trim().toLowerCase();
    const out: SearchSuggestion[] = [];
    if (!input) {
      // Empty input: recent submitted queries as selectable rows.
      for (const query of recentQueries.value) out.push({ kind: 'query', label: query, detail: '', value: query });
      return out;
    }
    for (const person of cachedCorrespondents.value) {
      if (out.length >= CORRESPONDENT_LIMIT) break;
      if ((person.displayName ?? '').toLowerCase().includes(input) || person.mailbox.toLowerCase().includes(input)) {
        out.push({ kind: 'correspondent', label: person.displayName ?? person.mailbox, detail: person.displayName ? person.mailbox : '', value: 'from:"' + person.mailbox + '"' });
      }
    }
    for (const query of recentQueries.value) {
      if (query.toLowerCase().startsWith(input)) out.push({ kind: 'query', label: query, detail: '', value: query });
    }
    return out;
  });
  // Inline mirror of the Rust-owned grammar (src/lib/search.ts): while typing,
  // name the exact problem; an invalid query is never submitted to searchMail.
  const searchProblem = computed(() => validateSearch(searchDraft.value));
  const searchError = computed(() => {
    const problem = searchProblem.value;
    if (!problem) return null;
    // An untouched empty input shows suggestions instead of an error; an empty
    // submit attempt does show it.
    if (!searchDraft.value.trim() && !searchAttemptedEmpty.value) return null;
    return problem;
  });
  const activeSuggestionId = computed(() => {
    const suggestion = suggestionsOpen.value ? searchSuggestions.value[suggestionIndex.value] : undefined;
    return suggestion ? suggestionId(suggestionIndex.value) : undefined;
  });
  watch(searchDraft, () => {
    searchAttemptedEmpty.value = false;
    suggestionIndex.value = -1;
    suggestionsOpen.value = true;
  });
  function recordRecentQuery(query: string): void {
    const trimmed = query.trim();
    if (!trimmed) return;
    recentQueries.value = [trimmed, ...recentQueries.value.filter((q) => q !== trimmed)].slice(0, RECENT_QUERY_LIMIT);
  }
  async function revealSearch(): Promise<void> {
    if (!accountReady.value || drawer.value || contactDisclosure.value || replyComposerOpen.value || composeCardOpen.value) return;
    searchVisible.value = true;
    searchDraft.value = mailbox.searchQuery.value;
    suggestionsOpen.value = true;
    suggestionIndex.value = -1;
    await nextTick();
    searchInput.value?.focus();
  }
  async function submitSearch(query = searchDraft.value): Promise<void> {
    if (!accountId.value) return;
    // An invalid query never reaches the provider; the inline error names why.
    if (validateSearch(query) !== null) {
      if (!query.trim()) searchAttemptedEmpty.value = true;
      return;
    }
    // Entering search closes the reader (and with it the docked inline reply
    // composer or compose card), so the active editor flushes through the
    // protected path first; a failed close keeps the reader and composer visible.
    if (!(await releaseEditorSurface())) return;
    if (mailbox.context.value !== 'search') {
      const saved = captureContext();
      if (saved) history.value.push(saved);
    }
    drawer.value = null;
    contactDisclosure.value = false;
    searchVisible.value = true;
    searchDraft.value = query;
    const token = nextNavigationToken();
    await mailbox.search(query, cachedSearch.value);
    if (token !== currentNavigationToken()) return;
    recordRecentQuery(query);
    cachedSearch.value = mailbox.searchCachedOnly.value;
    suggestionsOpen.value = false;
    // Auto-collapse (results-first chrome): a successful submit leaves the slim
    // header + coverage + list and moves focus to the first result row. The form
    // stays open when the submit errored (the banner points at it) or when the
    // user already typed a different draft while the search was in flight.
    // Reopen paths: /, the header Search glyph, the palette command and the
    // results-header query button — all go through revealSearch().
    const submitted = mailbox.context.value === 'search' && mailbox.searchQuery.value === query && mailbox.listState.value !== 'error';
    if (submitted && searchDraft.value === query) searchVisible.value = false;
    await focusFocusedRow();
  }
  function applySuggestion(suggestion: SearchSuggestion): void {
    suggestionIndex.value = -1;
    suggestionsOpen.value = false;
    void submitSearch(suggestion.value);
  }
  // The listbox is capped (CSS max-height), so a highlight outside the visible
  // band must scroll its option into view — on arrow keys and pointer moves.
  // The optional call keeps jsdom (no scrollIntoView) and odd hosts safe; the
  // command palette uses the same pattern.
  function scrollSuggestionIntoView(index: number): void {
    document.getElementById(suggestionId(index))?.scrollIntoView?.({ block: 'nearest' });
  }
  function highlightSuggestion(index: number): void {
    suggestionIndex.value = index;
    // Deferred: on a reopen (v-show just flipped back) the ul is still hidden in
    // this tick, and scrollIntoView on a display:none subtree is a no-op.
    void nextTick(() => scrollSuggestionIntoView(suggestionIndex.value));
  }
  function onSearchInputKeydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      // Esc in two steps: first close the suggestion list, then hide the form
      // WITHOUT leaving the search context (list + query header remain); a
      // second Esc, once focus is on the list, exits via the normal Back path.
      if (suggestionsOpen.value && searchSuggestions.value.length) { suggestionsOpen.value = false; return; }
      searchVisible.value = false;
      void focusFocusedRow();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    // The global handler ignores editable targets, so single-letter shortcuts
    // (BROWSE-10) stay inert while typing here; only the keys below are consumed.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!searchSuggestions.value.length) return; // native caret movement
      event.preventDefault();
      event.stopPropagation();
      // A closed listbox with available suggestions reopens on the arrow keys
      // (e.g. after Esc closed it) and restarts the highlight; with no
      // suggestions, the arrows keep the native caret movement.
      const wasClosed = !suggestionsOpen.value;
      suggestionsOpen.value = true;
      const count = searchSuggestions.value.length;
      suggestionIndex.value = wasClosed || suggestionIndex.value < 0
        ? (event.key === 'ArrowDown' ? 0 : count - 1)
        : (suggestionIndex.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
      void nextTick(() => scrollSuggestionIntoView(suggestionIndex.value));
      return;
    }
    if (event.key === 'Enter' && suggestionsOpen.value && searchSuggestions.value[suggestionIndex.value]) {
      // Enter applies the highlighted suggestion (fill + submit); with no
      // highlight it falls through to the native submit of the typed query.
      event.preventDefault();
      event.stopPropagation();
      applySuggestion(searchSuggestions.value[suggestionIndex.value]!);
    }
  }
  async function senderSearch(address: string): Promise<void> {
    await submitSearch('from:"' + address + '"');
  }

  return { searchVisible, searchDraft, searchInput, cachedSearch, recentQueries, suggestionsOpen, suggestionIndex, suggestionsId, suggestionId, searchSuggestions, searchError, activeSuggestionId, revealSearch, submitSearch, applySuggestion, highlightSuggestion, onSearchInputKeydown, senderSearch };
}
