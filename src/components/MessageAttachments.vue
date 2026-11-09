<script setup lang="ts">
/**
 * Inline attachment list for one expanded message that is known to have files
 * (`hasAttachment === true`). A plain list, one line per file: no cards, no
 * viewer, nothing opens. Saving is download-only through the same transfer
 * state as the Cmd+O chooser (`useAttachmentTransfer`), owned by the reader.
 * Everything is interpolated text; file names are never trusted as markup.
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { AttachmentDescriptor } from '../lib/ipc/generated';
import { attachmentKey } from '../composables/useAttachmentTransfer';
import { ATTACHMENT_LIMIT_BYTES, formatBytes } from '../lib/format-bytes';
import { displayFileName } from '../lib/display-name';
import RowGlyph from './RowGlyph.vue';

const props = defineProps<{
  messageId: string;
  /** Descriptors for THIS message only. */
  files: AttachmentDescriptor[];
  /** `failed`: the descriptor list could not be loaded. */
  loadState: 'ready' | 'failed';
  /** A retry of a failed load is in flight: the Retry button stays mounted but inert. */
  retrying?: boolean;
  /** Retained recovery snapshot: attachment fetch is unavailable. */
  retained: boolean;
  /** Key of the file being transferred, if any (one transfer at a time). */
  pending: string | null;
  /** Key of the file the status/error lines belong to. */
  target: string | null;
  status: string;
  error: string;
}>();

const emit = defineEmits<{
  save: [file: AttachmentDescriptor];
  cancel: [];
  retry: [];
}>();

const RETAINED_TITLE = 'Attachment fetch is unavailable for a retained recovery snapshot.';

/** Bidi controls are removed from what is shown (name, title and button label); the descriptor itself is untouched. */
function nameOf(file: AttachmentDescriptor): string {
  return displayFileName(file.filename);
}

const group = ref<HTMLElement | null>(null);

function retry(): void {
  // aria-disabled, not disabled: the button keeps focus, so it ignores clicks itself.
  if (!props.retrying) emit('retry');
}

// A successful retry swaps the note (and the focused Retry button) for the list.
// This watcher runs before that DOM update, while the button can still hold
// focus; the group then takes it so focus never falls to <body>. Focus that
// moved elsewhere in the meantime is left alone.
watch(() => props.loadState, async (state, previous) => {
  if (previous !== 'failed' || state !== 'ready') return;
  const hadFocus = !!group.value?.contains(document.activeElement);
  await nextTick();
  if (hadFocus) group.value?.focus();
});

const rows = computed(() => props.files.map((file) => ({
  file,
  key: attachmentKey(file),
  name: nameOf(file),
  tooLarge: file.size > ATTACHMENT_LIMIT_BYTES,
})));
</script>

<template>
  <div ref="group" class="message-attachments" role="group" aria-label="Attachments" tabindex="-1" :data-test="`message-attachments-${props.messageId}`">
    <div v-if="props.loadState === 'failed'" class="attachment-line">
      <p class="attachment-note" data-test="attachments-load-error">Could not load file details.</p>
      <button
        type="button"
        class="attachment-action"
        :aria-label="props.retrying ? 'Retrying…' : 'Retry loading file details'"
        :aria-disabled="props.retrying ? 'true' : undefined"
        data-test="attachments-retry"
        @click="retry"
      >{{ props.retrying ? 'Retrying…' : 'Retry' }}</button>
    </div>
    <p v-else-if="rows.length === 0" class="attachment-note" data-test="attachments-not-cached">Attachment details are not cached. Sync to fetch.</p>
    <ul v-else class="attachment-list">
      <li v-for="row in rows" :key="row.key" class="attachment-row" :data-test="`attachment-${row.file.attachmentId}`">
        <span class="attachment-line">
          <span class="attachment-glyph"><RowGlyph name="attachment" /></span>
          <span class="attachment-name" :title="row.name">{{ row.name }}</span>
          <span class="attachment-meta">{{ formatBytes(row.file.size) }} · {{ row.file.mimeType }}</span>
          <span v-if="row.tooLarge" class="attachment-meta" data-test="attachment-too-large">Over the 5 MB limit; cannot download.</span>
          <template v-else-if="props.pending && props.target === row.key">
            <span class="attachment-meta" data-test="attachment-saving">Saving…</span>
            <button type="button" class="attachment-action" :aria-label="`Cancel saving ${row.name}`" data-test="attachment-cancel" @click="emit('cancel')">Cancel</button>
          </template>
          <button
            v-else
            type="button"
            class="attachment-action"
            :aria-label="`Save ${row.name}`"
            :title="props.retained ? RETAINED_TITLE : undefined"
            :disabled="!!props.pending || props.retained"
            data-test="attachment-save"
            @click="emit('save', row.file)"
          >Save</button>
        </span>
        <template v-if="props.target === row.key">
          <p v-if="props.error" class="attachment-error" role="alert" data-test="attachment-error">{{ props.error }}</p>
          <p v-else-if="props.status" class="attachment-status" role="status" data-test="attachment-status">{{ props.status }}</p>
        </template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.message-attachments {
  margin: 0.4rem 0 0.2rem;
  font-size: var(--type-body);
  line-height: var(--leading-ui);
}

/* Programmatic focus only (after a successful retry): the same ring as every control. */
.message-attachments:focus-visible {
  outline: 2px solid var(--focus-accent);
  outline-offset: 1px;
  border-radius: 4px;
}

.attachment-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.attachment-line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 24px;
  min-width: 0;
}

.attachment-glyph {
  flex: none;
  display: inline-flex;
  color: var(--text-secondary);
}

.attachment-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.attachment-meta,
.attachment-note,
.attachment-status {
  color: var(--text-secondary);
}

.attachment-meta {
  flex: none;
  white-space: nowrap;
}

.attachment-note,
.attachment-status,
.attachment-error {
  margin: 0;
}

.attachment-status,
.attachment-error {
  padding-left: calc(16px + 0.5rem);
  overflow-wrap: anywhere;
}

.attachment-error {
  color: var(--danger);
}

.attachment-action {
  flex: none;
  color: var(--text-secondary);
}

.attachment-action:hover:not(:disabled, [aria-disabled='true']),
.attachment-action:focus-visible {
  color: var(--text-primary);
}

/* The active message is already Lifted Charcoal, so the default ghost hover would not show. */
.attachment-action:hover:not(:disabled, [aria-disabled='true']) {
  background: var(--focus-fill);
}

/* Retrying: dimmed like a disabled button, but still focusable. */
.attachment-action[aria-disabled='true'] {
  opacity: 0.45;
  cursor: default;
}
</style>
