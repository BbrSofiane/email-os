<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { AvailableAction, BrowsingActionId } from '../lib/browsing-actions';
const props = defineProps<{ kind: 'palette' | 'navigator'; actions: AvailableAction[] }>();
const emit = defineEmits<{ close: []; execute: [id: BrowsingActionId] }>();
const query = ref('');
const highlighted = ref(0);
const input = ref<HTMLInputElement | null>(null);
const results = computed(() => props.actions.filter((action) => action.label.toLowerCase().includes(query.value.toLowerCase())));
watch(results, () => { highlighted.value = 0; });
watch(highlighted, async () => {
  await nextTick();
  const action = results.value[highlighted.value];
  if (action) document.getElementById(`action-${action.id}`)?.scrollIntoView?.({ block: 'nearest' });
});
onMounted(async () => { await nextTick(); input.value?.focus(); });
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
    if (action) emit('execute', action.id);
  }
  // Input is the single keyboard tab stop; pointer results never trap focus elsewhere.
  if (event.key === 'Tab') { event.preventDefault(); input.value?.focus(); }
}
</script>
<template>
  <div class="action-backdrop" @click.self="emit('close')">
    <section class="action-overlay" role="dialog" aria-modal="true" :aria-label="kind === 'palette' ? 'Command palette' : 'Destination navigator'" @keydown="keydown">
      <label for="action-query">{{ kind === 'palette' ? 'Commands' : 'Destinations' }}</label>
      <input id="action-query" ref="input" v-model="query" data-test="action-query" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="action-results" :aria-activedescendant="results[highlighted] ? `action-${results[highlighted]!.id}` : undefined" autocomplete="off" />
      <ul id="action-results" role="listbox" aria-label="Available actions">
        <li v-for="(action, index) in results" :id="`action-${action.id}`" :key="action.id" role="option" :aria-selected="index === highlighted" :class="{ highlighted: index === highlighted }" @pointermove="highlighted = index" @mousedown.prevent @click="emit('execute', action.id)">
          <span>{{ action.label }}</span><kbd v-if="action.shortcut">{{ action.shortcut }}</kbd>
        </li>
      </ul>
      <p v-if="!results.length" role="status">No available commands.</p>
      <p class="action-hint">↑ ↓ choose · Enter execute · Escape close</p>
    </section>
  </div>
</template>
