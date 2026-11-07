<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { CachedTrashState } from '../lib/cached-trash';
import type { ConversationRef, MailClient } from '../lib/ipc/client';
import { toMailError } from '../lib/ipc/client';
const props = defineProps<{ client: MailClient; accountId: string; state: CachedTrashState }>();
const emit = defineEmits<{ open: [target: ConversationRef] }>();
const busy = ref(false);
const list = ref<HTMLElement | null>(null);
let alive = true;
onBeforeUnmount(() => { alive = false; });
async function load(reset = false): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  props.state.error = null;
  try {
    const page = await props.client.listCachedTrash({ accountId: props.accountId, limit: 50, cursor: reset ? null : props.state.cursor });
    if (!alive) return;
    props.state.rows = reset ? page.conversations : [...props.state.rows, ...page.conversations.filter(row => !props.state.rows.some(old => old.ref.accountId === row.ref.accountId && old.ref.conversationId === row.ref.conversationId))];
    props.state.cursor = page.nextCursor;
    props.state.loaded = true;
  } catch (error) { if (alive) props.state.error = toMailError(error); }
  finally { if (alive) busy.value = false; }
}
function open(target: ConversationRef): void {
  props.state.focusedId = target.conversationId;
  emit('open', { ...target });
}
onMounted(async () => {
  if (!props.state.loaded) await load(true);
  await nextTick();
  const buttons = list.value?.querySelectorAll<HTMLButtonElement>('button');
  [...buttons ?? []].find(button => button.dataset.id === props.state.focusedId)?.focus({ preventScroll: true });
  if (list.value) list.value.scrollTop = props.state.scrollTop;
});
</script>

<template>
  <section aria-label="Cached Trash browsing" :aria-busy="busy">
    <p>Known cached Trash only — not your complete Gmail Trash. Reading does not mark mail read.</p>
    <p>Loaded local snapshot — refresh to see later cache changes.</p>
    <p v-if="state.loaded" role="status">{{ state.rows.length }} cached conversations loaded. Total unknown.</p>
    <p>Trash is not Done. Move to Trash, Recover, permanent delete and Empty Trash are not available in this build. Use your provider client for recovery.</p>
    <button type="button" :disabled="busy" @click="load(true)">Refresh cached Trash</button>
    <p v-if="state.error" role="alert">Could not load cached Trash ({{ state.error.kind }}). <button type="button" :disabled="busy" @click="load(!state.loaded)">Retry</button></p>
    <p v-if="busy" role="status">Loading cached Trash…</p>
    <p v-else-if="state.loaded && !state.rows.length">No known cached Trash conversations. This does not mean your Gmail Trash is empty.</p>
    <ul ref="list" class="cached-trash-list" aria-label="Cached Trash conversations" @scroll="state.scrollTop = list?.scrollTop ?? 0">
      <li v-for="row in state.rows" :key="`${row.ref.accountId}:${row.ref.conversationId}`">
        <button type="button" :data-id="row.ref.conversationId" @click="open(row.ref)">{{ row.subject || '(No subject)' }}</button>
        <span>{{ row.primaryCorrespondent?.mailbox }}</span>
      </li>
    </ul>
    <button v-if="state.cursor" type="button" :disabled="busy" @click="load()">Load more cached Trash</button>
  </section>
</template>

<style scoped>
.cached-trash-list { max-height: 55vh; overflow: auto; padding-inline-start: 1.5rem; }
.cached-trash-list li { margin-block: 0.5rem; overflow-wrap: anywhere; }
.cached-trash-list button { max-width: 100%; white-space: normal; text-align: start; }
.cached-trash-list span { display: block; }
</style>
