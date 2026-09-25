<script setup lang="ts">
/**
 * Inbox list with roving selection (Slice 01).
 *
 * - Selection follows DOM focus (focusin -> select) so j/k, arrows, mouse, and
 *   screen-reader navigation stay consistent.
 * - When the selected row is removed (e.g. archived out of the inbox overlay), focus
 *   moves predictably to the row now at the selected index, but only if the list had
 *   focus.
 */
import { nextTick, onBeforeUpdate, ref, watch } from 'vue';
import type { ConversationSummaryLike } from '../composables/useMailbox';

const props = defineProps<{
  rows: ConversationSummaryLike[];
  selectedIndex: number;
}>();

const emit = defineEmits<{
  select: [index: number];
  open: [index: number];
}>();

const listEl = ref<HTMLElement | null>(null);
const rowEls = new Map<string, HTMLElement>();
let lastFocusedId: string | null = null;
let listHasFocus = false;

type ComponentPublicInstance = import('vue').ComponentPublicInstance;

onBeforeUpdate(() => {
  rowEls.clear();
});

function setRowRef(el: Element | ComponentPublicInstance | null, id: string): void {
  if (el instanceof HTMLElement) rowEls.set(id, el);
}

function onFocusIn(id: string, index: number): void {
  lastFocusedId = id;
  listHasFocus = true;
  emit('select', index);
}

function onFocusOut(): void {
  // Confirm asynchronously: the row may be replaced (e.g. archived out) rather than
  // truly losing focus; a macrotask later, re-check where focus actually lives.
  setTimeout(() => {
    listHasFocus = listEl.value !== null && listEl.value.contains(document.activeElement);
  }, 0);
}

function isSelected(index: number): boolean {
  return index === props.selectedIndex;
}

function rowIds(): string[] {
  return props.rows.map((r) => r.ref.conversationId);
}

watch(
  () => [props.rows.map((r) => r.ref.conversationId), props.selectedIndex] as const,
  async () => {
    await nextTick();
    if (!listHasFocus) return;
    // The focused row was removed from the list (e.g. archived out of the inbox
    // overlay): keep DOM focus predictable by moving it to the row now at the
    // selected index instead of dropping it to the document body.
    const focusedStillPresent = lastFocusedId !== null && rowIds().includes(lastFocusedId);
    if (!focusedStillPresent) {
      focusRow(props.selectedIndex);
    }
  },
);

function focusRow(index: number): void {
  const row = props.rows[index];
  if (!row) return;
  rowEls.get(row.ref.conversationId)?.focus();
}

defineExpose({ focusRow });
</script>

<template>
  <ul class="inbox-list" role="listbox" aria-label="Inbox conversations" ref="listEl">
    <li
      v-for="(row, index) in props.rows"
      :key="row.ref.conversationId"
      role="option"
      :aria-selected="isSelected(index)"
      :tabindex="isSelected(index) ? 0 : -1"
      class="inbox-row"
      :class="{ selected: isSelected(index) }"
      :ref="(el) => setRowRef(el, row.ref.conversationId)"
      @focusin="onFocusIn(row.ref.conversationId, index)"
      @focusout="onFocusOut"
      @click="emit('open', index)"
    >
      <div class="row-top">
        <span class="row-participants">{{ row.participants.map((p) => p.displayName ?? p.mailbox).join(', ') }}</span>
        <span class="row-time">{{ row.lastMessageAt }}</span>
      </div>
      <div class="row-subject">{{ row.subject }}</div>
      <div class="row-preview">{{ row.preview }}</div>
      <div v-if="row.pendingOperationId" class="row-pending" data-test="row-pending">
        pending archive operation…
      </div>
    </li>
  </ul>
</template>
