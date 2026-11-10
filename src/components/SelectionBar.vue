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
import type { BrowseContext } from '../composables/useMailbox';

const props = defineProps<{
  count: number;
  loadedCount: number;
  context: BrowseContext;
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

import { computed } from 'vue';
import { OPERATION_GROUP_MAX_MEMBERS } from '../lib/ipc/client';

// Reactive: the loaded count changes across pagination and new arrivals, so
// the enabled state and explanation must follow it, never the mount-time value.
const selectAllDisabled = computed(() => props.loadedCount > OPERATION_GROUP_MAX_MEMBERS);
const selectAllTitle = computed(() =>
  selectAllDisabled.value
    ? `Select all loaded is limited to ${OPERATION_GROUP_MAX_MEMBERS} conversations; ${props.loadedCount} rows are loaded.`
    : 'Select every currently loaded row (unseen pages are not included).',
);
const scopeCaveat = computed(
  () => `Selection covers the ${props.loadedCount} loaded conversations only; later arrivals and unseen pages are not included.`,
);
</script>

<template>
  <div class="selection-bar" role="group" aria-label="Selected conversations" data-test="selection-bar">
    <!-- Terse line; the exact scope lives in the title and a visually hidden description. -->
    <p class="selection-scope" data-test="selection-scope" :title="scopeCaveat">
      <strong data-test="selection-count">{{ count }} selected</strong>{{ ' ' }}<span class="selection-loaded-scope" data-test="selection-loaded-scope">· {{ loadedCount }} loaded</span>
      <span class="visually-hidden" data-test="selection-scope-caveat">{{ scopeCaveat }}</span>
    </p>
    <span class="selection-actions">
      <button
        v-if="context !== 'done'"
        type="button"
        data-test="selection-archive"
        :disabled="!actionsEnabled"
        @click="emit('archive')"
      >Mark {{ count }} done</button>
      <button
        v-if="context !== 'inbox'"
        type="button"
        data-test="selection-unarchive"
        :disabled="!actionsEnabled"
        @click="emit('unarchive')"
      >Mark {{ count }} not done</button>
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
