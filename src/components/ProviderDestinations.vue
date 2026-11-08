<script setup lang="ts">
/**
 * Read-only provider snapshots (catalog -> page -> reader). Nothing here writes.
 *
 * Keyboard row model: catalog rows, then page rows, are real buttons with a
 * roving tab stop. ArrowDown/ArrowUp and j/k move between rows, Enter opens
 * (native button), and Escape steps back one level (reader -> page list ->
 * catalog) before it falls through to App, which closes the drawer. Every
 * other key stays fenced off the covered inbox; the native palette binding
 * (Cmd+K) is the only key that passes through.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Conversation, DestinationCatalog, DestinationPage, MailClient, MailError, ProviderDestination } from '../lib/ipc/client';
import { toMailError } from '../lib/ipc/client';
import { describeMailError } from '../lib/account-status';
import FullDate from './FullDate.vue';

const props = defineProps<{ client: MailClient; accountId: string }>();
const INTRO_DETAIL = 'No automatic read changes. Label and Move are not available in this increment.';
const catalog = ref<DestinationCatalog | null>(null);
const destination = ref<ProviderDestination | null>(null);
const page = ref<DestinationPage | null>(null);
const opened = ref<Conversation | null>(null);
const query = ref('');
const shown = ref(9);
const busy = ref(false);
const error = ref<MailError | null>(null);
const cached = ref(false);
const list = ref<HTMLElement | null>(null);
const catalogList = ref<HTMLElement | null>(null);
const readerBack = ref<HTMLButtonElement | null>(null);
/** Roving tab stops: the row that last had focus in each list. */
const catalogActive = ref(0);
const pageActive = ref(0);
let listScrollTop = 0;
let generation = 0;
let origin: HTMLElement | null = null;
const matches = computed(() => (catalog.value?.destinations ?? []).filter(d => d.name.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())));
const visible = computed(() => matches.value.slice(0, shown.value));
const catalogStop = computed(() => Math.min(catalogActive.value, Math.max(visible.value.length - 1, 0)));
const pageStop = computed(() => Math.min(pageActive.value, Math.max((page.value?.conversations.length ?? 0) - 1, 0)));
const errorLine = computed(() => {
  if (!error.value) return '';
  const hasSnapshot = destination.value ? page.value !== null : catalog.value !== null;
  return `Could not load ${destination.value ? 'this page' : 'destinations'}. ${describeMailError(error.value)} ${hasSnapshot ? 'Showing the previous snapshot.' : 'Try Refresh, or use saved data.'}`;
});
watch(query, () => { catalogActive.value = 0; });
onBeforeUnmount(() => { generation += 1; });

async function loadCatalog(useCache = false) {
  const token = ++generation;
  busy.value = true; error.value = null;
  try {
    const result = await props.client.listProviderDestinations(props.accountId, useCache);
    if (token !== generation || result.accountId !== props.accountId) return;
    catalog.value = result; cached.value = useCache;
  } catch (e) { if (token === generation) error.value = toMailError(e); }
  finally { if (token === generation) busy.value = false; }
}
async function loadPage(target: ProviderDestination, cursor: string | null = null, useCache = false) {
  const token = ++generation;
  busy.value = true; error.value = null; opened.value = null;
  if (destination.value?.id !== target.id) page.value = null;
  destination.value = target;
  try {
    const result = await props.client.browseProviderDestination({ accountId: props.accountId, destinationId: target.id, cursor, cached: useCache });
    if (token !== generation || result.accountId !== props.accountId || result.destinationId !== target.id) return;
    page.value = result; cached.value = useCache;
    await nextTick(); list.value?.focus();
  } catch (e) { if (token === generation) error.value = toMailError(e); }
  finally { if (token === generation) busy.value = false; }
}
function open(conversation: Conversation, event: Event) {
  // A pending Refresh/Next will replace this page and disconnect the clicked
  // row: opening during the wait would strand the reader on a dead origin.
  if (busy.value) return;
  origin = event.currentTarget as HTMLElement;
  listScrollTop = list.value?.scrollTop ?? 0;
  opened.value = conversation;
  void nextTick(() => readerBack.value?.focus());
}
async function backToList() {
  opened.value = null;
  await nextTick();
  if (list.value) list.value.scrollTop = listScrollTop;
  if (origin?.isConnected) origin.focus({ preventScroll: true });
}
async function backToCatalog() {
  const leaving = destination.value?.id;
  generation += 1; busy.value = false; error.value = null; destination.value = null; page.value = null;
  await nextTick();
  // Focus returns to the destination row that opened this page.
  const rows = rowsIn(catalogList.value);
  (rows.find((row) => row.dataset.destinationId === leaving) ?? rows[0])?.focus({ preventScroll: true });
}

function rowsIn(container: HTMLElement | null): HTMLElement[] {
  return container ? [...container.querySelectorAll<HTMLElement>('[data-row]')].filter((row) => !(row as HTMLButtonElement).disabled) : [];
}
/** Moves focus between rows; returns true when it handled the key. */
function moveRow(event: KeyboardEvent): boolean {
  if (opened.value || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) return false;
  const step = event.key === 'ArrowDown' || event.key === 'j' ? 1 : event.key === 'ArrowUp' || event.key === 'k' ? -1 : 0;
  if (!step || !(event.target instanceof HTMLElement)) return false;
  const target = event.target;
  const container = destination.value ? list.value : catalogList.value;
  const rows = rowsIn(container);
  if (!rows.length) return false;
  let next: number;
  if (target.matches('[data-row]')) next = Math.min(rows.length - 1, Math.max(0, rows.indexOf(target) + step));
  // The list itself (focused after a page loads) and the search field (ArrowDown only: j/k are text there) enter the rows.
  else if (step === 1 && (target === list.value || (event.key === 'ArrowDown' && target.matches('input[type="search"]')))) next = 0;
  else return false;
  event.preventDefault();
  rows[next]!.focus({ preventScroll: false });
  return true;
}
function keydown(event: KeyboardEvent) {
  // The native palette binding must reach App's window handler even when focus
  // sits inside this drawer; ordinary keys stay fenced off the covered inbox.
  // Browser reservations and IME composition are left untouched (no
  // preventDefault outside the row keys and the Escape levels below).
  if (event.key === 'Escape' && (event.isComposing || event.keyCode === 229
    || event.ctrlKey || event.metaKey || event.altKey)) return;
  const nativePaletteKey = event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    && event.key.toLowerCase() === 'k' && !event.isComposing && event.keyCode !== 229;
  if (event.key === 'Escape') {
    // One level per press; at the catalog the key is left for App to close the drawer.
    if (opened.value) { event.preventDefault(); event.stopPropagation(); void backToList(); }
    else if (destination.value) { event.preventDefault(); event.stopPropagation(); void backToCatalog(); }
    return;
  }
  if (nativePaletteKey) return;
  event.stopPropagation();
  moveRow(event);
}
onMounted(() => { void loadCatalog(); });
</script>

<template>
  <section class="provider-destinations" aria-label="Provider destinations" @keydown="keydown">
    <p class="destination-intro" :title="INTRO_DETAIL"><span>Read-only provider snapshots.</span> <span class="visually-hidden">{{ INTRO_DETAIL }}</span></p>
    <template v-if="!destination">
      <label class="destination-find"><span class="visually-hidden">Find a destination</span><input v-model="query" class="destination-search" type="search" placeholder="Find a destination" /></label>
      <div class="destination-actions">
        <button type="button" class="drawer-ghost" :disabled="busy" @click="loadCatalog()">Refresh catalog</button>
        <button type="button" class="drawer-ghost" :disabled="busy" @click="loadCatalog(true)">Use saved catalog</button>
      </div>
      <p v-if="errorLine" class="destination-error" role="alert">{{ errorLine }}</p>
      <p v-if="busy" class="destination-state" role="status">{{ catalog ? 'Refreshing…' : 'Loading destinations…' }}</p>
      <p v-else-if="catalog" class="destination-meta">{{ cached ? 'Saved' : 'Provider' }} catalog · <FullDate :at="catalog.fetchedAt" /></p>
      <ul ref="catalogList" class="destination-catalog">
        <li v-for="(item, index) in visible" :key="item.id">
          <button
            type="button"
            class="destination-item"
            data-row
            :data-destination-id="item.id"
            :tabindex="index === catalogStop ? 0 : -1"
            :disabled="busy"
            @focus="catalogActive = index"
            @click="loadPage(item)"
          >{{ item.name }}</button>
        </li>
      </ul>
      <p v-if="catalog && !matches.length" class="destination-state">No destinations match this catalog search.</p>
      <button v-if="shown < matches.length" type="button" class="drawer-ghost" @click="shown += 9">Show more destinations</button>
    </template>
    <template v-else>
      <button v-if="!opened" type="button" class="drawer-ghost" @click="backToCatalog()">Back to destinations</button>
      <h3 class="destination-title">{{ destination.name }}</h3>
      <p v-if="destination.id === 'DRAFT'" class="destination-meta">Provider Drafts are read-only mail snapshots, separate from editable Local drafts. Nothing here syncs local drafts.</p>
      <p v-if="destination.id === 'ALL_MAIL'" class="destination-meta">All Mail excludes Spam and Trash.</p>
      <div v-show="!opened">
        <div class="destination-actions">
          <button type="button" class="drawer-ghost" :disabled="busy" @click="loadPage(destination)">Refresh first page</button>
          <button type="button" class="drawer-ghost" :disabled="busy" @click="loadPage(destination, null, true)">Use latest saved page</button>
        </div>
        <p v-if="errorLine" class="destination-error" role="alert">{{ errorLine }}</p>
        <p v-if="busy" class="destination-state" role="status">{{ page ? 'Refreshing…' : 'Loading conversations…' }}</p>
        <p v-else-if="page" class="destination-meta" role="status">{{ cached ? 'Saved local snapshot' : 'Provider page snapshot' }} · <FullDate :at="page.fetchedAt" /> · {{ page.conversations.length }} loaded on this page. Mailbox total unknown.</p>
        <div ref="list" class="destination-list" tabindex="-1" aria-label="Destination conversations">
          <button
            v-for="(conversation, index) in page?.conversations ?? []"
            :key="conversation.ref.accountId + ':' + conversation.ref.conversationId"
            type="button"
            class="destination-row"
            data-row
            :tabindex="index === pageStop ? 0 : -1"
            :disabled="busy"
            @focus="pageActive = index"
            @click="open(conversation, $event)"
          >{{ conversation.subject || '(No subject)' }}</button>
          <p v-if="page && !page.conversations.length" class="destination-state">No conversations on this page. This is not a mailbox-completeness claim.</p>
        </div>
        <button v-if="page?.nextCursor && !cached" type="button" class="drawer-ghost" :disabled="busy" @click="loadPage(destination, page.nextCursor)">Next provider page (up to 25)</button>
        <p v-if="cached && page?.nextCursor" class="destination-meta">More provider pages may exist; refresh online to continue.</p>
      </div>
      <article v-if="opened" aria-label="Destination conversation" class="destination-reader">
        <button ref="readerBack" type="button" class="drawer-ghost" data-test="destination-back" @click="backToList()">Back to {{ destination.name }}</button>
        <h3 class="destination-title">{{ opened.subject }}</h3>
        <p class="destination-meta">Snapshot only — provider state may have changed since the page was fetched.</p>
        <p v-if="opened.retainedSnapshotAt" class="destination-meta">Retained local recovery snapshot · <FullDate :at="opened.retainedSnapshotAt" /></p>
        <p v-if="opened.contextComplete === false || opened.unsupportedReason" class="destination-notice">Incomplete or unsupported content: {{ opened.unsupportedReason ?? 'Some messages unavailable' }}</p>
        <section v-for="message in opened.messages" :key="message.id" class="destination-message">
          <h4>{{ message.from.displayName || message.from.mailbox }}</h4>
          <p class="destination-meta">{{ message.from.mailbox }} · <FullDate :at="message.sentAt" /></p>
          <p v-if="message.to.length" class="destination-meta message-to">To {{ message.to.map((t) => t.displayName ?? t.mailbox).join(', ') }}</p>
          <pre>{{ message.bodyText }}</pre>
        </section>
      </article>
    </template>
  </section>
</template>
