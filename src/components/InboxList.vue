<script setup lang="ts">
/**
 * Compact conversation list (UX-01).
 *
 * - Focus is an explicit account-scoped conversation reference, never an array
 *   position and never bulk selection: rows use ordinary list/listitem
 *   semantics with roving tabindex and `aria-current` (not `aria-selected`),
 *   so a future selection model can diverge from focus.
 * - Row keys are account+conversation; DOM refs and navigation address
 *   conversations only. Group headings (date captions, or sender captions in
 *   a single-from search with nested date captions, P5b) are non-actionable
 *   and never tabbable; date headings never reorder the backend's rows, and
 *   sender grouping only buckets rows by sender, keeping backend order inside
 *   each group.
 * - Hover changes nothing: no hover handler mutates focus or read state.
 *   Inline actions are row-scoped buttons that stop propagation; focusing one
 *   never opens the row or scrolls it to center. Hover only reveals (CSS) the
 *   checkbox and action glyphs that the focused row already shows.
 * - Roving tabindex covers the row's inner controls too: only the tab-stop
 *   row's checkbox and actions are in the Tab sequence; other rows' controls
 *   stay programmatically focusable (tabindex -1) and pointer-operable.
 * - Anchor capture/restoration supports the reader round trip: a visible-row
 *   reference with its relative offset plus a scrollTop fallback.
 */
import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, reactive, ref, watch } from 'vue';
import type { ConversationRef } from '../lib/ipc/client';
import type { ConversationSummaryLike } from '../composables/useMailbox';
import { sameConversation } from '../composables/useMailbox';
import { actionLabel } from '../lib/browsing-actions';
import { compactDateLabel, dateGroupCaption, dateGroupFor, fullDateLabel, machineDateTime } from '../lib/browsing-dates';
import { groupRowsBySender, isSingleFromQuery, senderGroupKey, senderGroupLabel } from '../lib/search';
import RowGlyph from './RowGlyph.vue';

const props = defineProps<{
  rows: ConversationSummaryLike[];
  context?: 'inbox' | 'saved' | 'done' | 'starred' | 'search';
  /** Submitted query in search context; drives sender grouping for a single from: query (P5b). */
  searchQuery?: string;
  focusedRef: ConversationRef | null;
  actionsEnabled?: boolean;
  showReadState?: boolean;
  showReadControls?: boolean;
  /** UX-05: selected references (account-scoped); selection ≠ focus. */
  selectedRefs?: ConversationRef[];
}>();

const emit = defineEmits<{
  focus: [ref: ConversationRef];
  open: [ref: ConversationRef];
  archive: [ref: ConversationRef];
  unarchive: [ref: ConversationRef];
  setRead: [ref: ConversationRef, read: boolean];
  /** X / checkbox / Cmd-click: toggle one row (the parent moves focus/anchor). */
  selectToggle: [ref: ConversationRef];
  /** Shift-click / Cmd+Shift-click: additive anchor→row range. */
  selectRange: [ref: ConversationRef];
}>();

const selectedKeys = computed(() => new Set((props.selectedRefs ?? []).map((ref) => `${ref.accountId}:${ref.conversationId}`)));
/** Selection mode: any selected row reveals every row's gutter checkbox. */
const selecting = computed(() => selectedKeys.value.size > 0);

function isSelected(row: ConversationSummaryLike): boolean {
  return selectedKeys.value.has(`${row.ref.accountId}:${row.ref.conversationId}`);
}

/** Pointer click on a row: Cmd/Ctrl toggles, Shift/Cmd+Shift ranges, plain opens. */
function onRowClick(event: MouseEvent, row: ConversationSummaryLike): void {
  if (event.shiftKey) {
    emit('selectRange', row.ref);
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    emit('selectToggle', row.ref);
    return;
  }
  emit('open', row.ref);
}

/** A surviving list row plus the geometry needed to restore it. */
export interface RowAnchor {
  ref: ConversationRef;
  /** Row top relative to the scrollport top at capture time. */
  offsetTop: number;
  /** Scrollport scrollTop at capture time (fallback when geometry is unavailable). */
  scrollTop: number;
}

const listEl = ref<HTMLElement | null>(null);
const rowEls = new Map<string, HTMLElement>();
let lastFocusedKey: string | null = null;
let listHasFocus = false;
/** Guard so preventScroll focus does not trigger the focusin reveal. */
let preventScrollReveal = false;

/*
 * Adaptive compact action presentation: when a row's full inline metadata and
 * actions do not fit its laid-out width (larger user text, longer dates, the
 * 1000px contact breakpoint), the row keeps its one-line scanning rhythm by
 * collapsing the action buttons behind a small disclosure control. Read state,
 * pending, and date stay visible; the collapsed buttons keep their stable
 * data-test ids, accessible names, and event semantics — only their container
 * moves out of flow (measured while hidden, then shown as a row-anchored
 * disclosure panel while the toggle is operated).
 */
const compactRows = reactive(new Set<string>());
const openActionRows = reactive(new Set<string>());
/** Rows whose open disclosure panel opens upward (near the list bottom). */
const upwardPanels = reactive(new Set<string>());
/** Panel flip threshold in row-font em: the tallest disclosed panel plus slack. */
const PANEL_FLIP_EM = 6;
/** Slack for overflow detection: scrollWidth/clientWidth round to integers. */
const ROW_OVERFLOW_SLACK_PX = 1;
let rowLayoutObserver: ResizeObserver | null = null;
const rowKeyByEl = new Map<HTMLElement, string>();

type ComponentPublicInstance = import('vue').ComponentPublicInstance;

onBeforeUpdate(() => {
  rowEls.clear();
});

function rowKey(target: ConversationRef): string {
  return `${target.accountId}:${target.conversationId}`;
}

function setRowRef(el: Element | ComponentPublicInstance | null, key: string): void {
  if (el instanceof HTMLElement) {
    rowEls.set(key, el);
    rowKeyByEl.set(el, key);
  }
}

interface GroupItem {
  kind: 'group';
  key: string;
  caption: string;
  id: number;
  /** The list opens with Today: the caption stays for assistive technology only. */
  leading: boolean;
}
interface RowItem { kind: 'row'; row: ConversationSummaryLike; index: number }
type ListItem = GroupItem | RowItem;

/**
 * P5b sender grouping: in search context, a submitted query that is exactly one
 * non-excluded from: term (the contact-pane path) renders sender-grouped like
 * the reference, instead of flat date order. Rows are bucketed by their exact
 * sender — never re-sorted inside a group — and each group starts with one
 * "Name (count)" caption through the same non-actionable row-group mechanism
 * as the date captions, which then continue nested inside the group.
 */
const senderGroupingActive = computed(() =>
  props.context === 'search' && isSingleFromQuery(props.searchQuery ?? '') !== null);

/**
 * Backend order is preserved; a heading is emitted wherever the calendar
 * bucket changes between consecutive rows (never re-sorted here).
 *
 * A leading Today caption is visually hidden (DESIGN.md "Date Group
 * Caption"): today's rows already show a time instead of a date, so the
 * caption adds no information on screen, and without it the first row sits on
 * the first list line shared by the rail and contact pane. Any other leading
 * bucket (Yesterday, a month, Unknown date) stays visible, because the row
 * dates alone would not say where the list starts.
 *
 * When sender grouping is active (search context, single from: query) the
 * captions nest two levels: a sender caption starts each sender group (groups
 * in first-seen order, rows keep backend order inside a group, caption reads
 * "Name (count)"), and the date captions continue INSIDE the group with the
 * same dateGroupCaption logic and the same row-group styling. The leading
 * Today rule applies to the very first caption in the list, whether it is a
 * sender or a date caption: a list that opens with today's mail hides that
 * first caption on screen (it stays in the accessibility tree).
 */
const items = computed<ListItem[]>(() => {
  const result: ListItem[] = [];
  let groupId = 0;
  if (senderGroupingActive.value) {
    // Stable bucketing (shared with App's navigation order): groups in
    // first-seen order, rows keep their incoming order inside each group.
    const grouped = groupRowsBySender(
      props.rows.map((row, index) => ({ row, index })),
      (entry) => senderGroupKey(entry.row),
    );
    const counts = new Map<string, number>();
    for (const entry of grouped) {
      const key = senderGroupKey(entry.row);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // A list that opens with today's mail hides its very first caption —
    // whether that caption is the leading sender or a leading date caption.
    const opensToday = props.rows.length > 0 && dateGroupFor(props.rows[0]!.lastMessageAt) === 'today';
    let previousKey: string | null = null;
    let previousDateKey: string | null = null;
    for (const entry of grouped) {
      const key = senderGroupKey(entry.row);
      if (key !== previousKey) {
        previousKey = key;
        // The sender caption heads the group; date captions continue inside it.
        previousDateKey = null;
        groupId += 1;
        result.push({ kind: 'group', key: `sender:${key}`, caption: `${senderGroupLabel(entry.row)} (${counts.get(key)})`, id: groupId, leading: result.length === 0 && opensToday });
      }
      const dateKey = dateGroupFor(entry.row.lastMessageAt);
      if (dateKey !== previousDateKey) {
        previousDateKey = dateKey;
        groupId += 1;
        result.push({ kind: 'group', key: dateKey, caption: dateGroupCaption(dateKey), id: groupId, leading: result.length === 0 && dateKey === 'today' });
      }
      result.push({ kind: 'row', row: entry.row, index: entry.index });
    }
    return result;
  }
  let previousKey: string | null = null;
  props.rows.forEach((row, index) => {
    const key = dateGroupFor(row.lastMessageAt);
    if (key !== previousKey) {
      previousKey = key;
      groupId += 1;
      result.push({ kind: 'group', key, caption: dateGroupCaption(key), id: groupId, leading: groupId === 1 && key === 'today' });
    }
    result.push({ kind: 'row', row, index });
  });
  return result;
});

function isFocused(row: ConversationSummaryLike): boolean {
  return sameConversation(row.ref, props.focusedRef);
}

/**
 * Roving tabindex: the focused row, else the first row, is the tab stop. The
 * same value gates that row's inner controls (checkbox, actions, disclosure).
 */
function tabIndexFor(row: ConversationSummaryLike, index: number): 0 | -1 {
  if (isFocused(row)) return 0;
  if (props.focusedRef === null && index === 0) return 0;
  return -1;
}

function senderLabel(row: ConversationSummaryLike): string {
  const primary = row.primaryCorrespondent;
  // Absent primaryCorrespondent never becomes a guessed contact.
  if (!primary) return 'Unknown sender';
  return primary.displayName ?? primary.mailbox;
}

/** Read facts are disclosed (gutter dot + sender weight) only where the provider supplies them. */
function readStateDisclosed(): boolean {
  return Boolean(props.showReadState || props.showReadControls);
}

/*
 * The gutter marker is a glyph (filled dot = unread, hollow ring = unknown,
 * nothing visible = read); its exact state always lives in the accessible
 * name, so the bounded row never trades the subject for a text label and an
 * unknown fact is never rendered as silence.
 */
function readStateName(row: ConversationSummaryLike): string {
  if (row.isRead === undefined) return 'Read state unknown';
  return row.isRead ? 'Read' : 'Unread';
}

function hasRowActions(): boolean {
  return Boolean(props.showReadControls || props.actionsEnabled);
}

/** DOM id of the row's action disclosure panel (for aria-controls). */
function actionsPanelId(row: ConversationSummaryLike): string {
  return `row-actions-${row.ref.accountId}-${row.ref.conversationId}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

function isCompactRow(row: ConversationSummaryLike): boolean {
  return compactRows.has(rowKey(row.ref));
}

function isActionsOpen(row: ConversationSummaryLike): boolean {
  // Open state is tracked independently of the measured compact presentation;
  // CSS only reveals the panel when the row is both compact and open.
  return openActionRows.has(rowKey(row.ref));
}

function isPanelUpward(row: ConversationSummaryLike): boolean {
  return upwardPanels.has(rowKey(row.ref));
}

function toggleActions(row: ConversationSummaryLike): void {
  const key = rowKey(row.ref);
  if (openActionRows.has(key)) {
    openActionRows.delete(key);
    return;
  }
  openActionRows.add(key);
  // Open away from the nearer list edge so the panel never extends past the
  // list scroller's visible box when the row sits near its bottom.
  upwardPanels.delete(key);
  const el = rowEls.get(key);
  const scroller = listEl.value;
  if (!el || !scroller || scroller.clientHeight === 0 || el.clientHeight === 0) return;
  const em = parseFloat(getComputedStyle(el).fontSize) || 16;
  const below = scroller.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
  if (below < PANEL_FLIP_EM * em) upwardPanels.add(key);
}

function closeActions(row: ConversationSummaryLike, refocusToggle: boolean): void {
  const key = rowKey(row.ref);
  if (!openActionRows.delete(key) || !refocusToggle) return;
  rowEls.get(key)?.querySelector<HTMLElement>('.row-actions-toggle')?.focus();
}

/**
 * Decide per row whether the full inline presentation fits the laid-out row.
 * Measured, not assumed: in the compact presentation the actions span stays in
 * the DOM out of flow (absolute, hidden, max-content width), so the expanded
 * width is exactly the current overflow measurement plus the toggle/action
 * width swap — no threshold guessing, no layout flip-flop. Runs synchronously
 * from the ResizeObserver callback, so a row never paints an overflowing
 * expanded layout.
 */
function evaluateRowLayout(el: HTMLElement, key: string): void {
  if (!el.isConnected || el.clientWidth === 0) return;
  const actions = el.querySelector<HTMLElement>('.row-actions');
  // Rows without actions never overflow into the disclosure.
  if (!actions) return;
  const toggle = el.querySelector<HTMLElement>('.row-actions-toggle');
  const date = el.querySelector<HTMLElement>('.row-time');
  let fitsExpanded: boolean;
  if (compactRows.has(key)) {
    const actionsWidth = actions.getBoundingClientRect().width;
    const toggleWidth = toggle ? toggle.getBoundingClientRect().width : 0;
    const dateWidth = date ? date.getBoundingClientRect().width : 0;
    // The date and the actions (or the disclosure toggle) share one trailing
    // slot, so the slot is as wide as its widest occupant: expanding swaps
    // max(date, toggle) for max(date, actions). Strict margin: only leave the
    // compact presentation when the expanded layout measurably fits, so
    // integer-rounded overflow cannot oscillate.
    const slotGrowth = Math.max(dateWidth, actionsWidth) - Math.max(dateWidth, toggleWidth);
    fitsExpanded = el.scrollWidth + slotGrowth <= el.clientWidth - ROW_OVERFLOW_SLACK_PX;
  } else {
    fitsExpanded = el.scrollWidth <= el.clientWidth + ROW_OVERFLOW_SLACK_PX;
  }
  if (fitsExpanded) compactRows.delete(key);
  else compactRows.add(key);
}

/**
 * Observed per row: the row box, and its sender label. With the fixed-px rail
 * and contact pane, a root-font (text size) change no longer resizes the row
 * box, but it always resizes the sender's line box, so the row is re-measured
 * when its content grows inside an unchanged box.
 */
const rowKeyByProbe = new Map<Element, string>();

function observeRowLayouts(): void {
  if (!rowLayoutObserver) return;
  rowLayoutObserver.disconnect();
  rowKeyByEl.clear();
  rowKeyByProbe.clear();
  for (const [key, el] of rowEls) {
    rowKeyByEl.set(el, key);
    rowLayoutObserver.observe(el);
    const sender = el.querySelector('.row-sender');
    if (sender) {
      rowKeyByProbe.set(sender, key);
      rowLayoutObserver.observe(sender);
    }
  }
}

onMounted(() => {
  // Non-layout environments (jsdom component tests) keep the expanded
  // presentation; the rendered-layout regression covers the compact one.
  if (typeof ResizeObserver !== 'function') return;
  rowLayoutObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const target = entry.target;
      const key = target instanceof HTMLElement ? rowKeyByEl.get(target) ?? rowKeyByProbe.get(target) : rowKeyByProbe.get(target);
      const el = key ? rowEls.get(key) : undefined;
      if (key && el) evaluateRowLayout(el, key);
    }
  });
  observeRowLayouts();
});

onBeforeUnmount(() => {
  rowLayoutObserver?.disconnect();
  rowLayoutObserver = null;
  viewportObserver?.disconnect();
  viewportObserver = null;
});

/*
 * The bottom dock (selection bar, action notice) grows upward into the list
 * viewport instead of pushing rows down. When that shrink would clip the
 * focused row at the bottom edge, scroll just enough to keep it whole; a row
 * that was already out of view stays where the user scrolled it.
 */
let viewportObserver: ResizeObserver | null = null;
let viewportHeight: number | null = null;

function keepFocusedRowInView(): void {
  const list = listEl.value;
  if (!list) return;
  const previous = viewportHeight;
  viewportHeight = list.clientHeight;
  if (previous === null || viewportHeight >= previous || !props.focusedRef) return;
  const row = rowEls.get(rowKey(props.focusedRef));
  if (!row) return;
  const listBox = list.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  const visibleBottom = listBox.top + list.clientHeight;
  const wasVisible = rowBox.top < listBox.top + previous && rowBox.bottom > listBox.top;
  if (wasVisible && rowBox.bottom > visibleBottom) list.scrollTop += rowBox.bottom - visibleBottom;
}

onMounted(() => {
  if (typeof ResizeObserver !== 'function' || !listEl.value) return;
  viewportObserver = new ResizeObserver(() => keepFocusedRowInView());
  viewportObserver.observe(listEl.value);
});

/*
 * Re-observe (which re-measures every row) when the row set changes, and when
 * a fact that widens the trailing metadata changes without resizing the row
 * box (pending, read state, attachment state, star coverage, the available
 * actions):
 * ResizeObserver alone would miss
 * those and leave a newly overflowing row in the expanded presentation.
 */
watch(
  () => `${props.actionsEnabled}|${props.showReadControls}|${props.showReadState}|${props.context}\n` + props.rows.map((row) => `${rowKey(row.ref)}|${row.pendingOperationId ?? ''}|${String(row.isRead)}|${String(row.hasAttachments)}|${row.stars ? `${row.stars.starredMessages}/${row.stars.knownMessages}/${row.stars.totalMessages}` : ''}`).join('\n'),
  () => observeRowLayouts(),
  { flush: 'post' },
);

function onFocusIn(event: FocusEvent, row: ConversationSummaryLike): void {
  const key = rowKey(row.ref);
  lastFocusedKey = key;
  listHasFocus = true;
  if (!sameConversation(row.ref, props.focusedRef)) emit('focus', row.ref);
  // Only the row itself scrolls; an inline button receiving focus must not
  // yank the row to center or reopen it. Programmatic preventScroll focus
  // restoration suppresses the automatic reveal so it cannot undo a caller's
  // (e.g. anchor-restoration) scroll positioning.
  if (event.target === event.currentTarget && !preventScrollReveal) revealRow(key);
}

function revealRow(key: string): void {
  const el = rowEls.get(key);
  if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
}

function onFocusOut(event: FocusEvent): void {
  // Confirm asynchronously: the row may be replaced (e.g. archived out) rather than
  // truly losing focus; a macrotask later, re-check where focus actually lives.
  const rowEl = event.currentTarget;
  setTimeout(() => {
    listHasFocus = listEl.value !== null && listEl.value.contains(document.activeElement);
    // A row-scoped action disclosure closes when focus leaves its row, so an
    // open panel never lingers behind unrelated rows or surfaces.
    if (rowEl instanceof HTMLElement) {
      const key = rowKeyByEl.get(rowEl);
      if (key && openActionRows.has(key) && !rowEl.contains(document.activeElement)) {
        openActionRows.delete(key);
      }
    }
  }, 0);
}

/**
 * Local Escape precedence: while the row's action disclosure is open, Escape
 * closes it and returns focus to the disclosure control before any app-level
 * Escape handling sees the event. Closed disclosures leave Escape untouched.
 */
function onRowKeydown(event: KeyboardEvent, row: ConversationSummaryLike): void {
  if (!openActionRows.has(rowKey(row.ref))) return;
  event.preventDefault();
  event.stopPropagation();
  closeActions(row, true);
}

function focusRef(target: ConversationRef, options: { preventScroll?: boolean } = {}): void {
  const el = rowEls.get(rowKey(target));
  if (!el || el.closest('[inert]')) return;
  if (options.preventScroll) preventScrollReveal = true;
  el.focus({ preventScroll: options.preventScroll ?? false });
  preventScrollReveal = false;
  if (!options.preventScroll) revealRow(rowKey(target));
}

function captureAnchor(): RowAnchor | null {
  const scroller = listEl.value;
  if (!scroller || props.rows.length === 0) return null;
  const scrollerRect = scroller.getBoundingClientRect();
  const rowAt = (index: number): HTMLElement | null => {
    const row = props.rows[index];
    return row ? rowEls.get(rowKey(row.ref)) ?? null : null;
  };
  // The focused row, the row holding DOM focus, or the first row at/below the
  // top edge — whichever is visible first.
  let chosen: HTMLElement | null = null;
  let chosenRef: ConversationRef | null = null;
  const active = document.activeElement;
  if (active instanceof HTMLElement && scroller.contains(active)) {
    const activeRow = active.closest('li.inbox-row');
    if (activeRow instanceof HTMLElement) {
      for (const row of props.rows) {
        if (rowEls.get(rowKey(row.ref)) === activeRow) {
          chosen = activeRow;
          chosenRef = row.ref;
          break;
        }
      }
    }
  }
  if (!chosen && props.focusedRef) {
    const focusedEl = rowEls.get(rowKey(props.focusedRef));
    if (focusedEl) {
      const rect = focusedEl.getBoundingClientRect();
      if (rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom) {
        chosen = focusedEl;
        chosenRef = props.focusedRef;
      }
    }
  }
  if (!chosen) {
    for (let index = 0; index < props.rows.length; index += 1) {
      const el = rowAt(index);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom >= scrollerRect.top) {
        chosen = el;
        chosenRef = props.rows[index]!.ref;
        break;
      }
    }
  }
  if (!chosen || !chosenRef) return null;
  return {
    ref: { ...chosenRef },
    offsetTop: chosen.getBoundingClientRect().top - scrollerRect.top,
    scrollTop: scroller.scrollTop,
  };
}

async function restoreAnchor(anchor: RowAnchor): Promise<void> {
  await nextTick();
  const scroller = listEl.value;
  if (!scroller) return;
  const el = rowEls.get(rowKey(anchor.ref));
  if (!el || typeof el.getBoundingClientRect !== 'function') {
    scroller.scrollTop = anchor.scrollTop;
    return;
  }
  const scrollerRect = scroller.getBoundingClientRect();
  const relativeTop = el.getBoundingClientRect().top - scrollerRect.top;
  // Apply the measured delta to the current scrollTop: the replacement scroller
  // starts at zero after the reader unmounted the list, so using the captured
  // scrollTop would double-count the original offset. anchor.scrollTop remains
  // only as the missing-row fallback above.
  scroller.scrollTop = scroller.scrollTop + (relativeTop - anchor.offsetTop);
}

watch(
  () => [props.rows.map((row) => rowKey(row.ref)), props.focusedRef] as const,
  async () => {
    await nextTick();
    if (!listHasFocus) return;
    // The focused row was removed from the list (e.g. archived out of the inbox
    // overlay): keep DOM focus predictable by moving it to the row matching the
    // composable's resolved focus reference instead of dropping it to the body.
    const focusedStillPresent = lastFocusedKey !== null && rowEls.has(lastFocusedKey);
    if (!focusedStillPresent && props.focusedRef) focusRef(props.focusedRef);
  },
);

defineExpose({ focusRef, captureAnchor, restoreAnchor });
</script>

<template>
  <ul class="inbox-list inbox-scroll" :class="{ selecting }" role="list" :aria-label="context === 'search' ? 'Search results' : context === 'starred' ? 'Cached Starred conversations' : context === 'done' ? 'Cached Done conversations' : context === 'saved' ? 'Saved split conversations' : 'Inbox conversations'" ref="listEl">
    <template v-for="item in items" :key="item.kind === 'group' ? `group-${item.id}` : rowKey(item.row.ref)">
      <li
        v-if="item.kind === 'group'"
        class="row-group"
        :class="{ 'visually-hidden': item.leading }"
        role="presentation"
      >{{ item.caption }}</li>
      <li
        v-else
        role="listitem"
        class="inbox-row"
        :class="{
          focused: isFocused(item.row),
          selected: isSelected(item.row),
          'meta-compact': isCompactRow(item.row),
          'actions-open': isActionsOpen(item.row),
          'actions-up': isPanelUpward(item.row),
          'read-disclosed': readStateDisclosed(),
          'is-read': item.row.isRead === true,
          'has-actions': hasRowActions(),
        }"
        :aria-current="isFocused(item.row) ? 'true' : undefined"
        :tabindex="tabIndexFor(item.row, item.index)"
        :data-test="`conversation-row-${item.row.ref.conversationId}`"
        :ref="(el) => setRowRef(el, rowKey(item.row.ref))"
        @focusin="onFocusIn($event, item.row)"
        @focusout="onFocusOut"
        @keydown.escape="onRowKeydown($event, item.row)"
        @click="onRowClick($event, item.row)"
      >
        <!-- UX-05 selection control: a native labelled checkbox in the 44px
             gutter; it stops propagation and never opens the row. Revealed by
             selection mode, hover, the focused row, or its own focus. No
             aria-selected on listitem (invalid for role=listitem); aria-current
             stays the focus cue and the selected class is not color-only. -->
        <input
          type="checkbox"
          class="row-select"
          :data-test="`row-select-${item.row.ref.conversationId}`"
          :checked="isSelected(item.row)"
          :aria-label="`Select ${item.row.subject}`"
          :tabindex="tabIndexFor(item.row, item.index)"
          @click.stop
          @change="emit('selectToggle', item.row.ref)"
        />
        <!-- Gutter read marker: exact state in the accessible name. -->
        <span
          v-if="readStateDisclosed()"
          class="row-read-state"
          :data-test="item.row.isRead === undefined ? 'row-read-unknown' : item.row.isRead ? 'row-read' : 'row-unread'"
          role="img"
          :aria-label="readStateName(item.row)"
          :title="item.row.isRead === true ? undefined : readStateName(item.row)"
        ></span>
        <span class="row-sender">{{ senderLabel(item.row) }}</span>
        <span class="row-subject-snippet">
          <span class="row-subject">{{ item.row.subject }}</span>
          <span class="row-preview">{{ item.row.preview }}</span>
        </span>
        <span class="row-meta">
          <span
            v-if="item.row.pendingOperationId"
            class="row-pending"
            data-test="row-pending"
            role="status"
          >Pending…</span>
          <span
            v-if="item.row.stars && (item.row.stars.starredMessages > 0 || item.row.stars.knownMessages < item.row.stars.totalMessages || item.row.stars.totalMessages === 0)"
            class="row-stars" data-test="row-stars" role="img"
            :aria-label="`${item.row.stars.starredMessages > 0 ? 'Starred' : 'Star state unknown'}; effective star values known for ${item.row.stars.knownMessages} of ${item.row.stars.totalMessages} cached messages; may include pending intent`"
            :title="`Effective star values known for ${item.row.stars.knownMessages} of ${item.row.stars.totalMessages} cached messages; pending intent is not provider confirmation`"
          >{{ item.row.stars.starredMessages > 0 ? '★' : 'Star unknown' }}{{ item.row.stars.knownMessages < item.row.stars.totalMessages ? ' (partial)' : '' }}</span>
          <!-- P5a/P3: attachment glyph before the date (DESIGN.md row spec),
               three-state like the read marker: solid paperclip on a KNOWN
               hasAttachments === true, outline paperclip when the state is
               unknown (undefined/absent), nothing when known false — an
               unknown fact is never rendered as silence, and never as a
               guessed marker. -->
          <span
            v-if="item.row.hasAttachments === true"
            class="row-attachment"
            data-test="row-attachment"
            role="img"
            aria-label="Has attachments"
            title="Has attachments"
          ><RowGlyph name="attachment" /></span>
          <span
            v-else-if="item.row.hasAttachments == null"
            class="row-attachment row-attachment-unknown"
            data-test="row-attachment-unknown"
            role="img"
            aria-label="Attachment state unknown"
            title="Attachment state unknown"
          ><RowGlyph name="attachment-outline" /></span>
          <!-- One trailing slot: the date at rest; on the focused or hovered
               row the action glyphs (or, when they do not fit, the disclosure
               control) take its place without changing the row's width. -->
          <span class="row-trailing">
            <time class="row-time" :datetime="machineDateTime(item.row.lastMessageAt)" :title="fullDateLabel(item.row.lastMessageAt)">{{ compactDateLabel(item.row.lastMessageAt) }}</time>
            <button
              v-if="hasRowActions()"
              type="button"
              class="row-action row-actions-toggle"
              :data-test="`row-actions-toggle-${item.row.ref.conversationId}`"
              aria-label="More actions"
              title="More actions"
              :aria-expanded="isActionsOpen(item.row) ? 'true' : 'false'"
              :aria-controls="actionsPanelId(item.row)"
              :tabindex="tabIndexFor(item.row, item.index)"
              @click.stop="toggleActions(item.row)"
            ><RowGlyph name="more" /></button>
            <span
              v-if="hasRowActions()"
              :id="actionsPanelId(item.row)"
              class="row-actions"
              role="group"
              aria-label="Row actions"
            >
              <template v-if="props.showReadControls && item.row.isRead === undefined">
                <button type="button" class="row-action" :data-test="`row-mark-read-${item.row.ref.conversationId}`" aria-label="Mark read" title="Mark read" :tabindex="tabIndexFor(item.row, item.index)" @click.stop="emit('setRead', item.row.ref, true)"><RowGlyph name="mark-read" /><span class="row-action-label">Read</span></button>
                <button type="button" class="row-action" :data-test="`row-mark-unread-${item.row.ref.conversationId}`" aria-label="Mark unread" title="Mark unread" :tabindex="tabIndexFor(item.row, item.index)" @click.stop="emit('setRead', item.row.ref, false)"><RowGlyph name="mark-unread" /><span class="row-action-label">Unread</span></button>
              </template>
              <button
                v-else-if="props.showReadControls"
                type="button"
                class="row-action"
                :data-test="`row-toggle-read-${item.row.ref.conversationId}`"
                :title="`Mark ${item.row.isRead ? 'unread' : 'read'}`"
                :tabindex="tabIndexFor(item.row, item.index)"
                @click.stop="emit('setRead', item.row.ref, !item.row.isRead)"
              ><RowGlyph :name="item.row.isRead ? 'mark-unread' : 'mark-read'" /><span class="row-action-label">Mark {{ item.row.isRead ? 'unread' : 'read' }}</span></button>
              <button
                v-if="props.actionsEnabled && context !== 'starred'"
                type="button"
                class="row-action row-archive-action"
                :data-test="`row-archive-${item.row.ref.conversationId}`"
                :title="actionLabel(context === 'done' ? 'unarchive' : 'archive')"
                :tabindex="tabIndexFor(item.row, item.index)"
                @click.stop="context === 'done' ? emit('unarchive', item.row.ref) : emit('archive', item.row.ref)"
              ><RowGlyph :name="context === 'done' ? 'restore' : 'archive'" /><span class="row-action-label">{{ context === 'done' ? 'Mark not done' : 'Mark done' }}</span></button>
            </span>
          </span>
        </span>
      </li>
    </template>
  </ul>
</template>
