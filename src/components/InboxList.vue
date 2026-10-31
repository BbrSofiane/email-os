<script setup lang="ts">
/**
 * Compact conversation list (UX-01).
 *
 * - Focus is an explicit account-scoped conversation reference, never an array
 *   position and never bulk selection: rows use ordinary list/listitem
 *   semantics with roving tabindex and `aria-current` (not `aria-selected`),
 *   so a future selection model can diverge from focus.
 * - Row keys are account+conversation; DOM refs and navigation address
 *   conversations only. Date group headings are non-actionable and never
 *   tabbable, and they never reorder the backend's rows.
 * - Hover changes nothing: no hover handler mutates focus or read state.
 *   Inline actions are row-scoped buttons that stop propagation; focusing one
 *   never opens the row or scrolls it to center.
 * - Anchor capture/restoration supports the reader round trip: a visible-row
 *   reference with its relative offset plus a scrollTop fallback.
 */
import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, reactive, ref, watch } from 'vue';
import type { ConversationRef } from '../lib/ipc/client';
import type { ConversationSummaryLike } from '../composables/useMailbox';
import { sameConversation } from '../composables/useMailbox';
import { actionLabel } from '../lib/browsing-actions';
import { compactDateLabel, dateGroupCaption, dateGroupFor } from '../lib/browsing-dates';

const props = defineProps<{
  rows: ConversationSummaryLike[];
  context?: 'inbox' | 'done';
  focusedRef: ConversationRef | null;
  actionsEnabled?: boolean;
  showReadState?: boolean;
  showReadControls?: boolean;
}>();

const emit = defineEmits<{
  focus: [ref: ConversationRef];
  open: [ref: ConversationRef];
  archive: [ref: ConversationRef];
  unarchive: [ref: ConversationRef];
  setRead: [ref: ConversationRef, read: boolean];
}>();

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

interface GroupItem { kind: 'group'; key: string; caption: string; id: number }
interface RowItem { kind: 'row'; row: ConversationSummaryLike; index: number }
type ListItem = GroupItem | RowItem;

/**
 * Backend order is preserved; a heading is emitted wherever the calendar
 * bucket changes between consecutive rows (never re-sorted here).
 */
const items = computed<ListItem[]>(() => {
  const result: ListItem[] = [];
  let previousKey: string | null = null;
  let groupId = 0;
  props.rows.forEach((row, index) => {
    const key = dateGroupFor(row.lastMessageAt);
    if (key !== previousKey) {
      previousKey = key;
      groupId += 1;
      result.push({ kind: 'group', key, caption: dateGroupCaption(key), id: groupId });
    }
    result.push({ kind: 'row', row, index });
  });
  return result;
});

function isFocused(row: ConversationSummaryLike): boolean {
  return sameConversation(row.ref, props.focusedRef);
}

/** Roving tabindex: the focused row, else the first row, is the tab stop. */
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

/*
 * Compact visible labels; the full disclosure lives in the accessible name so
 * the bounded metadata region never starves the subject column at the 1000px
 * contact breakpoint (rows render "Unknown" + Read/Unread, AT reads the
 * complete "Read state unknown" / "Mark read" / "Mark unread" semantics).
 */
function readStateLabel(row: ConversationSummaryLike): string {
  if (row.isRead === undefined) return 'Unknown';
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
  let fitsExpanded: boolean;
  if (compactRows.has(key)) {
    const actionsWidth = actions.getBoundingClientRect().width;
    const toggleWidth = toggle ? toggle.getBoundingClientRect().width : 0;
    // Strict margin: only leave the compact presentation when the expanded
    // layout measurably fits, so integer-rounded overflow cannot oscillate.
    fitsExpanded =
      el.scrollWidth + (actionsWidth - toggleWidth) <= el.clientWidth - ROW_OVERFLOW_SLACK_PX;
  } else {
    fitsExpanded = el.scrollWidth <= el.clientWidth + ROW_OVERFLOW_SLACK_PX;
  }
  if (fitsExpanded) compactRows.delete(key);
  else compactRows.add(key);
}

function observeRowLayouts(): void {
  if (!rowLayoutObserver) return;
  rowLayoutObserver.disconnect();
  rowKeyByEl.clear();
  for (const [key, el] of rowEls) {
    rowKeyByEl.set(el, key);
    rowLayoutObserver.observe(el);
  }
}

onMounted(() => {
  // Non-layout environments (jsdom component tests) keep the expanded
  // presentation; the rendered-layout regression covers the compact one.
  if (typeof ResizeObserver !== 'function') return;
  rowLayoutObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target;
      if (!(el instanceof HTMLElement)) continue;
      const key = rowKeyByEl.get(el);
      if (key) evaluateRowLayout(el, key);
    }
  });
  observeRowLayouts();
});

onBeforeUnmount(() => {
  rowLayoutObserver?.disconnect();
  rowLayoutObserver = null;
});

watch(
  () => props.rows.map((row) => rowKey(row.ref)),
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
  if (!el) return;
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
  <ul class="inbox-list inbox-scroll" role="list" :aria-label="context === 'done' ? 'Cached Done conversations' : 'Inbox conversations'" ref="listEl">
    <template v-for="item in items" :key="item.kind === 'group' ? `group-${item.id}` : rowKey(item.row.ref)">
      <li
        v-if="item.kind === 'group'"
        class="row-group"
        role="presentation"
      >{{ item.caption }}</li>
      <li
        v-else
        role="listitem"
        class="inbox-row"
        :class="{
          focused: isFocused(item.row),
          'meta-compact': isCompactRow(item.row),
          'actions-open': isActionsOpen(item.row),
          'actions-up': isPanelUpward(item.row),
        }"
        :aria-current="isFocused(item.row) ? 'true' : undefined"
        :tabindex="tabIndexFor(item.row, item.index)"
        :data-test="`conversation-row-${item.row.ref.conversationId}`"
        :ref="(el) => setRowRef(el, rowKey(item.row.ref))"
        @focusin="onFocusIn($event, item.row)"
        @focusout="onFocusOut"
        @keydown.escape="onRowKeydown($event, item.row)"
        @click="emit('open', item.row.ref)"
      >
        <span class="row-sender" :class="{ unread: item.row.isRead === false }">{{ senderLabel(item.row) }}</span>
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
            v-if="props.showReadState || props.showReadControls"
            class="row-read-state"
            :data-test="item.row.isRead === undefined ? 'row-read-unknown' : item.row.isRead ? 'row-read' : 'row-unread'"
            :aria-label="item.row.isRead === undefined ? 'Read state unknown' : undefined"
          >{{ readStateLabel(item.row) }}</span>
          <span class="row-time">{{ compactDateLabel(item.row.lastMessageAt) }}</span>
          <button
            v-if="hasRowActions()"
            type="button"
            class="row-actions-toggle"
            :data-test="`row-actions-toggle-${item.row.ref.conversationId}`"
            aria-label="More actions"
            :aria-expanded="isActionsOpen(item.row) ? 'true' : 'false'"
            :aria-controls="actionsPanelId(item.row)"
            @click.stop="toggleActions(item.row)"
          >More</button>
          <span
            v-if="hasRowActions()"
            :id="actionsPanelId(item.row)"
            class="row-actions"
            role="group"
            aria-label="Row actions"
          >
            <template v-if="props.showReadControls && item.row.isRead === undefined">
              <button type="button" :data-test="`row-mark-read-${item.row.ref.conversationId}`" aria-label="Mark read" @click.stop="emit('setRead', item.row.ref, true)">Read</button>
              <button type="button" :data-test="`row-mark-unread-${item.row.ref.conversationId}`" aria-label="Mark unread" @click.stop="emit('setRead', item.row.ref, false)">Unread</button>
            </template>
            <button
              v-else-if="props.showReadControls"
              type="button"
              :data-test="`row-toggle-read-${item.row.ref.conversationId}`"
              @click.stop="emit('setRead', item.row.ref, !item.row.isRead)"
            >Mark {{ item.row.isRead ? 'unread' : 'read' }}</button>
            <button
              v-if="props.actionsEnabled"
              type="button"
              class="row-archive-action"
              :data-test="`row-archive-${item.row.ref.conversationId}`"
              :title="actionLabel(context === 'done' ? 'unarchive' : 'archive')"
              @click.stop="context === 'done' ? emit('unarchive', item.row.ref) : emit('archive', item.row.ref)"
            >{{ context === 'done' ? 'Restore to Inbox' : 'Archive' }}</button>
          </span>
        </span>
      </li>
    </template>
  </ul>
</template>
