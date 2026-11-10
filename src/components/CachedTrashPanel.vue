<script setup lang="ts">
/**
 * Cached Trash browsing (read-only). One Ash coverage line states the standing
 * limits once; the full caveat is its title and visually hidden text. Rows are
 * the shared drawer rows: one real button per conversation (sender, subject,
 * last message date), moved with the shared roving keyboard model.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { CachedTrashState } from '../lib/cached-trash';
import type { ConversationRef, ConversationSummary, MailClient } from '../lib/ipc/client';
import { toMailError } from '../lib/ipc/client';
import { compactDateLabel, fullDateLabel, machineDateTime } from '../lib/browsing-dates';
import { useDrawerRows } from '../composables/useDrawerRows';

const COVERAGE_LINE = 'Cached Trash only, not your full Gmail Trash.';
const COVERAGE_DETAIL = 'Known cached Trash only, not your complete Gmail Trash; the total is unknown. '
  + 'This is a local snapshot: refresh to see later cache changes. Reading does not mark mail read. '
  + 'Trash is not Done. Move to Trash, Recover, permanent delete and Empty Trash are not available in this build; use your provider client for recovery.';

const props = defineProps<{ client: MailClient; accountId: string; state: CachedTrashState }>();
const emit = defineEmits<{ open: [target: ConversationRef] }>();
const busy = ref(false);
const list = ref<HTMLElement | null>(null);
let alive = true;
onBeforeUnmount(() => { alive = false; });

const rows = useDrawerRows({
  keys: () => props.state.rows.map((row) => row.ref.conversationId),
  initial: () => props.state.focusedId,
});

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

/** Same rule as the Inbox row: the name when known, else the mailbox, else "Unknown sender". */
function senderLabel(row: ConversationSummary): string {
  const primary = row.primaryCorrespondent;
  if (!primary) return 'Unknown sender';
  return primary.displayName ?? primary.mailbox;
}

const loadingFirst = computed(() => busy.value && !props.state.loaded);

onMounted(async () => {
  if (!props.state.loaded) await load(true);
  await nextTick();
  const buttons = list.value?.querySelectorAll<HTMLButtonElement>('button');
  [...buttons ?? []].find(button => button.dataset.id === props.state.focusedId)?.focus({ preventScroll: true });
  if (list.value) list.value.scrollTop = props.state.scrollTop;
});
</script>

<template>
  <div class="cached-trash" data-test="cached-trash-panel" :aria-busy="busy">
    <!-- The standing coverage limits: one Ash line; the detail is its title and hidden text. -->
    <p class="drawer-note cached-trash-coverage" data-test="cached-trash-coverage" :title="COVERAGE_DETAIL">
      {{ COVERAGE_LINE }}<span class="visually-hidden"> {{ COVERAGE_DETAIL }}</span>
    </p>
    <div class="drawer-toolbar">
      <p v-if="busy" class="drawer-note" role="status">Loading cached Trash…</p>
      <p v-else-if="state.loaded && state.rows.length" class="drawer-note" role="status" data-test="cached-trash-count">{{ state.rows.length }} cached · total unknown</p>
      <span v-else></span>
      <button type="button" class="drawer-quiet" title="Refresh cached Trash" aria-label="Refresh cached Trash" :disabled="busy" @click="load(true)">Refresh</button>
    </div>
    <p v-if="state.error" role="alert" class="drawer-alert tone-fault">Could not load cached Trash ({{ state.error.kind }}). <button type="button" class="drawer-quiet" :disabled="busy" @click="load(!state.loaded)">Retry</button></p>
    <p v-if="!busy && state.loaded && !state.rows.length" class="drawer-note">No known cached Trash conversations. This does not mean your Gmail Trash is empty.</p>
    <ul
      ref="list"
      class="drawer-rows cached-trash-list"
      aria-label="Cached Trash conversations"
      :aria-busy="busy || loadingFirst"
      @scroll="state.scrollTop = list?.scrollTop ?? 0"
      @keydown="rows.onKeydown"
    >
      <li v-for="row in state.rows" :key="`${row.ref.accountId}:${row.ref.conversationId}`">
        <div class="drawer-row">
          <button
            type="button"
            class="drawer-row-main"
            v-bind="rows.rowAttrs(row.ref.conversationId)"
            :data-id="row.ref.conversationId"
            @click="open(row.ref)"
          >
            <span class="drawer-sender">{{ senderLabel(row) }}</span>
            <span class="drawer-subject">{{ row.subject || '(No subject)' }}</span>
            <time class="drawer-date row-time" :datetime="machineDateTime(row.lastMessageAt)" :title="fullDateLabel(row.lastMessageAt)">{{ compactDateLabel(row.lastMessageAt) }}</time>
          </button>
        </div>
      </li>
    </ul>
    <p v-if="state.cursor" class="drawer-line"><button type="button" class="drawer-quiet" aria-label="Load more cached Trash" title="Load more cached Trash" :disabled="busy" @click="load()">Load more</button></p>
  </div>
</template>
