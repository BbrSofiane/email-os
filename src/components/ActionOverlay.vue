<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { AvailableAction, BrowsingActionId } from '../lib/browsing-actions';
import { actionAliases, actionGroupOf, actionGroups, compactShortcut, keyHints, matchesQuery, type KeyScope } from '../lib/action-palette';
import CommandGlyph from './CommandGlyph.vue';
const props = withDefaults(defineProps<{
  kind: 'palette' | 'navigator';
  actions: AvailableAction[];
  idPrefix?: string;
  query?: string;
  /** Account commands (Connect, Sync now) that can fix a visible problem rank above Go to. */
  accountFirst?: boolean;
  /** A failed sync's one fix: the Account group leads the whole palette (implies accountFirst). */
  accountTop?: boolean;
  /** False when the list has no rows: J/K, X and Shift+J/K then have nothing to act on. */
  rowKeys?: boolean;
  /** The list context that owns the context-scoped key hints. */
  keyScope?: KeyScope;
}>(), { accountFirst: false, accountTop: false, rowKeys: true });
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
const groupRank = Object.keys(actionGroupOf);
const groupLabel = (id: BrowsingActionId) => actionGroups.find((group) => group.id === actionGroupOf[id])!.label;
// Grouped in a fixed order; a stable sort keeps each group's own order. The navigator is one group, so it stays unlabelled.
// While Connect or a failed sync can be fixed, the Account group sits right before Go to
// (below the conversation, selection and view commands, so triage keys keep their order).
const groupOrder = computed(() => {
  const ids = actionGroups.map((group) => group.id);
  if (props.accountTop) return ['account' as const, ...ids.filter((id) => id !== 'account')];
  if (!props.accountFirst) return ids;
  return ids.filter((id) => id !== 'account').flatMap((id) => (id === 'goto' ? ['account' as const, id] : [id]));
});
const results = computed(() => props.actions
  .filter((action) => matchesQuery(query.value, action.label, [...(actionAliases[action.id] ?? []), ...(action.aliases ?? [])], [action.shortcut]))
  .sort((a, b) => groupOrder.value.indexOf(actionGroupOf[a.id]) - groupOrder.value.indexOf(actionGroupOf[b.id]) || groupRank.indexOf(a.id) - groupRank.indexOf(b.id)));
const showGroups = computed(() => props.kind === 'palette');
// Keys with no command behind them: shown for teaching, never highlighted or executed.
const hints = computed(() => props.kind === 'palette'
  ? keyHints.filter((hint) => (props.rowKeys || !hint.needsRows) && (!hint.scope || hint.scope === props.keyScope) && matchesQuery(query.value, hint.label, hint.aliases, hint.keys))
  : []);
const emptyCopy = computed(() => {
  const noun = props.kind === 'palette' ? 'command' : 'destination';
  return query.value.trim() ? `No ${noun} matches “${query.value.trim()}”.` : `No ${noun}s available here.`;
});
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
    <section class="action-overlay command-overlay" role="dialog" aria-modal="true" :aria-label="kind === 'palette' ? 'Command palette' : 'Destination navigator'" @keydown="keydown">
      <input :id="queryId" :placeholder="kind === 'palette' ? 'Type a command…' : 'Go to…'" :aria-label="kind === 'palette' ? 'Command' : 'Destination'" ref="input" v-model="query" data-test="action-query" role="combobox" aria-autocomplete="list" aria-expanded="true" :aria-controls="resultsId" :aria-activedescendant="results[highlighted] ? actionId(results[highlighted]!.id) : undefined" autocomplete="off" />
      <ul :id="resultsId" role="listbox" aria-label="Available actions">
        <template v-for="(action, index) in results" :key="action.id">
          <li v-if="showGroups && (index === 0 || actionGroupOf[results[index - 1]!.id] !== actionGroupOf[action.id])" class="action-group" role="presentation">{{ groupLabel(action.id) }}</li>
          <li :id="actionId(action.id)" role="option" :aria-selected="index === highlighted" :aria-disabled="action.disabledReason ? true : undefined" :aria-describedby="action.disabledReason ? `${prefix}action-reason-${action.id}` : undefined" :class="{ highlighted: index === highlighted }" @pointermove="highlighted = index" @mousedown.prevent @click="execute(action)">
            <CommandGlyph :id="action.id" />
            <span class="action-copy"><span>{{ action.label }}</span><span v-if="action.disabledReason" :id="`${prefix}action-reason-${action.id}`" class="action-disabled-reason">{{ action.disabledReason }}</span></span>
            <kbd v-if="action.shortcut" :title="compactShortcut(action.shortcut) !== action.shortcut ? action.shortcut : undefined">{{ compactShortcut(action.shortcut) }}</kbd>
          </li>
        </template>
      </ul>
      <section v-if="hints.length" class="action-keys" aria-label="Keys">
        <p class="action-group">Keys</p>
        <ul>
          <li v-for="hint in hints" :key="hint.id"><span class="action-copy">{{ hint.label }}</span><span class="action-keycaps"><kbd v-for="keycap in hint.keys" :key="keycap">{{ keycap }}</kbd></span></li>
        </ul>
      </section>
      <p v-if="!results.length" role="status">{{ emptyCopy }}</p>
      <p class="action-hint">↑ ↓ choose · Enter execute · Escape close</p>
    </section>
  </div>
</template>
