<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Conversation, MailClient } from '../lib/ipc/client';
import type { AttachmentDescriptor } from '../lib/ipc/generated';
import { attachmentKey, useAttachmentTransfer } from '../composables/useAttachmentTransfer';
import { displayFileName } from '../lib/display-name';
import { ATTACHMENT_LIMIT_BYTES, formatBytes } from '../lib/format-bytes';
const props = defineProps<{ client: MailClient; conversation: Conversation; preview: boolean; idPrefix?: string }>();
const titleId = `${props.idPrefix ? `${props.idPrefix}-` : ''}attachment-title`;
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement | null>(null);
const files = ref<AttachmentDescriptor[]>([]);
const loading = ref(true);
const { pending, status, error, target, save: startSave, cancel } = useAttachmentTransfer({
  client: () => props.client,
  conversation: () => props.conversation.ref,
  preview: () => props.preview,
});
const confirmUrl = ref<string | null>(null);
const isSaving = (file: AttachmentDescriptor): boolean => !!pending.value && target.value === attachmentKey(file);
// aria-disabled, not disabled: a button that is disabled while it holds focus drops
// focus to <body>, and this modal's Escape and Tab trap only hear keys inside the panel.
function save(file: AttachmentDescriptor) { if (!pending.value) void startSave(file); }
function reload() { if (!loading.value && !pending.value) void load(); }
// The Cancel transfer button exists only while a transfer runs. If it holds focus when the
// transfer stops, the file's Save takes focus instead; focus that moved elsewhere is left alone.
watch(pending, async (now, previous) => {
  if (now || !previous) return;
  const hadFocus = document.activeElement instanceof HTMLElement && document.activeElement.matches('[data-test="chooser-cancel"]');
  const key = target.value;
  await nextTick();
  if (!hadFocus) return;
  const saves = [...(panel.value?.querySelectorAll<HTMLElement>('[data-test="chooser-save"]') ?? [])];
  (saves.find((b) => b.dataset.key === key) ?? saves[0] ?? panel.value?.querySelector<HTMLElement>('button'))?.focus();
}, { flush: 'pre' });
let live = true;
let loadGeneration = 0;
const links = computed(() => {
  const links = new Set<string>();
  for (const message of props.conversation.messages) {
    // Literal plaintext tokens only: no HTML interpretation, mailto, or remote discovery.
    for (const match of message.bodyText.matchAll(/https?:\/\/[^\s<>"']{1,2048}/gi)) {
      try {
        const url = new URL(match[0]);
        if (!url.username && !url.password && url.hostname && match[0].length <= 2048) links.add(url.href);
      } catch { /* not a known safe URL */ }
      if (links.size === 32) return [...links];
    }
  }
  return [...links];
});
async function load() {
  const generation = ++loadGeneration;
  loading.value = true; error.value = '';
  try {
    const result = await props.client.listAttachments(props.conversation.ref);
    if (live && generation === loadGeneration) files.value = result;
  } catch { if (live && generation === loadGeneration) error.value = 'Could not load cached file descriptors. Reading remains available.'; }
  finally { if (live && generation === loadGeneration) loading.value = false; }
}
async function openLink() {
  if (!confirmUrl.value) return;
  try {
    await props.client.openExternalLink(confirmUrl.value);
    if (live) { status.value = props.preview ? 'Modelled external open only; no browser was launched.' : 'Handed link to the system browser.'; confirmUrl.value = null; }
  } catch { if (live) error.value = 'External browser unavailable or protocol rejected. You can copy the link instead.'; }
}
async function copyLink(url: string) {
  try { await navigator.clipboard.writeText(url); if (live) status.value = 'Link copied.'; }
  catch { if (live) error.value = 'Clipboard unavailable. The link is shown as plain text.'; }
}
function keydown(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); }
  if (event.key === 'Tab') {
    const controls = [...(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])];
    const first = controls[0]; const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
}
onMounted(async () => { void load(); await nextTick(); panel.value?.querySelector('button')?.focus(); });
onBeforeUnmount(() => { live = false; });
</script>
<template>
  <div class="action-backdrop" @click.self="emit('close')">
    <section ref="panel" class="action-overlay attachment-chooser" role="dialog" aria-modal="true" :aria-labelledby="titleId" @keydown="keydown">
      <header><h2 :id="titleId">Files and links</h2><button type="button" @click="emit('close')">Back to message</button></header>
      <p class="chooser-note" title="Up to 32 cached files and 32 plain-text links. PDF preview is unavailable pending a macOS security review.">Download only. Files save inert with a .download suffix; nothing is opened.</p>
      <p v-if="conversation.retainedSnapshotAt" role="note">Retained recovery snapshot: attachment fetch is unavailable.</p>
      <p v-if="loading" role="status">Loading cached files…</p>
      <p v-if="error" role="alert">{{ error }} <button type="button" :aria-disabled="loading || !!pending ? 'true' : undefined" @click="reload">Reload file list</button></p>
      <p v-if="status" role="status">{{ status }}</p>
      <ul aria-label="Files">
        <li v-for="file in files" :key="`${file.messageId}:${file.attachmentId}`">
          <span>{{ displayFileName(file.filename) }} — {{ file.mimeType }}, {{ formatBytes(file.size) }}</span>
          <span v-if="file.size > ATTACHMENT_LIMIT_BYTES">Over the 5 MB limit; cannot download.</span>
          <button v-else type="button" data-test="chooser-save" :data-key="attachmentKey(file)" :aria-label="`${isSaving(file) ? 'Saving' : 'Save'} ${displayFileName(file.filename)}`" :aria-disabled="pending ? 'true' : undefined" :disabled="!!conversation.retainedSnapshotAt" @click="save(file)">{{ isSaving(file) ? 'Saving…' : 'Save' }}</button>
        </li>
      </ul>
      <p v-if="!loading && !files.length">No cached files. Sync to fetch any that are missing.</p>
      <button v-if="pending" type="button" data-test="chooser-cancel" @click="cancel">Cancel transfer</button>
      <ul aria-label="Links"><li v-for="url in links" :key="url"><span>{{ url }}</span> <button type="button" @click="copyLink(url)">Copy link</button> <button type="button" @click="confirmUrl = url">Open link…</button></li></ul>
      <p v-if="!links.length">No HTTP(S) links found in cached plain text. Email addresses are not browser links.</p>
      <div v-if="confirmUrl" role="group" aria-label="Confirm external browser">
        <p>Leave Email OS and open this link in your system browser? {{ confirmUrl }}</p>
        <button type="button" @click="openLink">Open in browser</button>
        <button type="button" @click="confirmUrl = null">Keep reading</button>
      </div>
    </section>
  </div>
</template>
<style scoped>
.attachment-chooser { max-height: 80vh; overflow-y: auto; overflow-wrap: anywhere; }
header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; }
h2 { font-size: var(--type-headline); font-weight: var(--weight-regular); }
/* The lists sit on the same x as the text above them (no default 40px indent). */
ul { padding-inline-start: 0; }
li { border: 0; cursor: default; padding-block: .5rem; display: flex; gap: .5rem; flex-wrap: wrap; }
p { line-height: 1.5; }
.chooser-note { color: var(--text-secondary); }
</style>
