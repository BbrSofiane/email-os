<script setup lang="ts">
/**
 * Compact selection action bar (UX-05 §3.1/§6).
 *
 * Shows the selected count against the loaded scope with explicit desired-state
 * actions (never a mixed-state read toggle), Select all loaded / Clear, and the
 * honest bound/loaded-scope wording. Select all loaded is disabled with an
 * explanation when more than the 100-conversation bound is loaded. The count is
 * announced through the app-level polite live region, not from here.
 */
const props = defineProps<{
  count: number;
  loadedCount: number;
  context: 'inbox' | 'done';
  /** Archive/unarchive groups need the same capability gates as singles. */
  actionsEnabled?: boolean;
  /** Read groups are Gmail-only like the single setter. */
  readAvailable?: boolean;
  /** Bound/scope wording from the last rejected selection change. */
  limitMessage?: string | null;
}>();

const emit = defineEmits<{
  archive: [];
  unarchive: [];
  markRead: [];
  markUnread: [];
  selectAll: [];
  clear: [];
}>();

import { OPERATION_GROUP_MAX_MEMBERS } from '../lib/ipc/client';

const selectAllDisabled = props.loadedCount > OPERATION_GROUP_MAX_MEMBERS;
const selectAllTitle = selectAllDisabled
  ? `Select all loaded is limited to ${OPERATION_GROUP_MAX_MEMBERS} conversations; ${props.loadedCount} rows are loaded.`
  : 'Select every currently loaded row (unseen pages are not included).';
</script>

<template>
  <div class="selection-bar" role="group" aria-label="Selected conversations" data-test="selection-bar">
    <p class="selection-scope" data-test="selection-scope">
      <strong data-test="selection-count">{{ count }} selected</strong>
      <span class="selection-loaded-scope">of {{ loadedCount }} loaded — later arrivals and unseen pages are not included</span>
    </p>
    <span class="selection-actions">
      <button
        v-if="context === 'inbox'"
        type="button"
        data-test="selection-archive"
        :disabled="!actionsEnabled"
        @click="emit('archive')"
      >Mark {{ count }} Done</button>
      <button
        v-if="context === 'done'"
        type="button"
        data-test="selection-unarchive"
        :disabled="!actionsEnabled"
        @click="emit('unarchive')"
      >Mark {{ count }} Not Done</button>
      <!-- Explicit Mark N read / Mark N unread: never a mixed-state toggle. -->
      <button
        v-if="readAvailable"
        type="button"
        data-test="selection-mark-read"
        @click="emit('markRead')"
      >Mark {{ count }} read</button>
      <button
        v-if="readAvailable"
        type="button"
        data-test="selection-mark-unread"
        @click="emit('markUnread')"
      >Mark {{ count }} unread</button>
      <button
        type="button"
        data-test="selection-select-all"
        :disabled="selectAllDisabled"
        :title="selectAllTitle"
        @click="emit('selectAll')"
      >Select all loaded ({{ loadedCount }})</button>
      <button type="button" data-test="selection-clear" @click="emit('clear')">Clear selection</button>
    </span>
    <p v-if="limitMessage" class="selection-limit" role="note" data-test="selection-limit">{{ limitMessage }}</p>
  </div>
</template>
