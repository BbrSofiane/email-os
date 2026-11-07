<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { AvailableAction, BrowsingActionId } from '../lib/browsing-actions';
const props = defineProps<{ kind: 'palette' | 'navigator'; actions: AvailableAction[]; idPrefix?: string; query?: string }>();
const emit = defineEmits<{ close: []; execute: [id: BrowsingActionId]; 'update:query': [query: string] }>();
const prefix = props.idPrefix ? `${props.idPrefix}-` : '';
const queryId = `${prefix}action-query`;
const resultsId = `${prefix}action-results`;
const actionId = (id: string) => `${prefix}action-${id}`;
// Only workspace palettes opt into controlled persistence; other overlays reset on mount.
const localQuery = ref('');
const query = computed({
  get: () => props.query ?? localQuery.value,
  set: (value: string) => {
    if (props.query === undefined) localQuery.value = value;
    else emit('update:query', value);
  },
});
const highlighted = ref(0);
const input = ref<HTMLInputElement | null>(null);
const results = computed(() => props.actions.filter((action) => action.label.toLowerCase().includes(query.value.toLowerCase())));
watch(results, () => { highlighted.value = 0; });
watch(highlighted, async () => {
  await nextTick();
  const action = results.value[highlighted.value];
  if (action) document.getElementById(actionId(action.id))?.scrollIntoView?.({ block: 'nearest' });
});
onMounted(async () => { await nextTick(); if (!input.value?.closest('[inert]')) { input.value?.focus(); input.value?.select(); } });
function execute(action: AvailableAction): void {
  if (!action.disabledReason) emit('execute', action.id);
}
function keydown(event: KeyboardEvent): void {
  event.stopPropagation();
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); }
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const count = results.value.length;
    if (count) highlighted.value = (highlighted.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const action = results.value[highlighted.value];
    if (action) execute(action);
  }
  // Input is the single keyboard tab stop; pointer results never trap focus elsewhere.
  if (event.key === 'Tab') { event.preventDefault(); input.value?.focus(); }
}
</script>
<template>
  <div class="action-backdrop" @click.self="emit('close')">
    <section class="action-overlay" role="dialog" aria-modal="true" :aria-label="kind === 'palette' ? 'Command palette' : 'Destination navigator'" @keydown="keydown">
      <label :for="queryId" class="action-heading"><span aria-hidden="true">{{ kind === 'palette' ? 'ϟ' : '↗' }}</span>{{ kind === 'palette' ? 'Email Command' : 'Destinations' }}</label>
      <input :id="queryId" :placeholder="kind === 'palette' ? 'Type a command…' : 'Go to…'" ref="input" v-model="query" data-test="action-query" role="combobox" aria-autocomplete="list" aria-expanded="true" :aria-controls="resultsId" :aria-activedescendant="results[highlighted] ? actionId(results[highlighted]!.id) : undefined" autocomplete="off" />
      <ul :id="resultsId" role="listbox" aria-label="Available actions">
        <li v-for="(action, index) in results" :id="actionId(action.id)" :key="action.id" role="option" :aria-selected="index === highlighted" :aria-disabled="action.disabledReason ? true : undefined" :aria-describedby="action.disabledReason ? `${prefix}action-reason-${action.id}` : undefined" :class="{ highlighted: index === highlighted }" @pointermove="highlighted = index" @mousedown.prevent @click="execute(action)">
          <svg v-if="action.id === 'star' || action.id === 'unstar'" class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" /><path v-if="action.id === 'unstar'" d="m4 4 16 16" /></svg>
          <span v-else class="action-icon" aria-hidden="true">↗</span>
          <span class="action-copy"><span>{{ action.label }}</span><span v-if="action.disabledReason" :id="`${prefix}action-reason-${action.id}`" class="action-disabled-reason">{{ action.disabledReason }}</span></span>
          <kbd v-if="action.shortcut">{{ action.shortcut }}</kbd>
        </li>
      </ul>
      <p v-if="!results.length" role="status">No available commands.</p>
      <p class="action-hint">↑ ↓ choose · Enter execute · Escape close</p>
    </section>
  </div>
</template>
