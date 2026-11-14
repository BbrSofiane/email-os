<script setup lang="ts">
/**
 * One 16px glyph per command. Reuses the row, header and pane families where
 * the same idea already has a glyph (Done check, restore, envelopes, star,
 * clock, magnifier, destinations); the few palette-only ideas are drawn here
 * in the same 16px, 1.4 stroke grid. Decorative: the label is the name.
 * Which glyph a command uses is declared with the command in the registry.
 */
import { computed } from 'vue';
import { actionDefinition, type ActionId } from '../lib/action-registry';
import HeaderGlyph from './HeaderGlyph.vue';
import PaneGlyph from './PaneGlyph.vue';
import RowGlyph from './RowGlyph.vue';

const props = defineProps<{ id: ActionId }>();
const glyph = computed(() => actionDefinition(props.id).glyph);
</script>

<template>
  <span class="action-icon" aria-hidden="true">
    <RowGlyph v-if="glyph.family === 'row'" :name="glyph.name" />
    <HeaderGlyph v-else-if="glyph.family === 'header'" :name="glyph.name" :filled="glyph.filled" />
    <PaneGlyph v-else-if="glyph.family === 'pane'" :name="glyph.name" />
    <svg
      v-else-if="glyph.family === 'own'"
      class="command-glyph"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      focusable="false"
    >
      <!-- Open conversation: an arrow into the thread. -->
      <template v-if="glyph.shape === 'open'">
        <path d="M2.75 8h9.5" />
        <path d="M8.5 4.25L12.25 8 8.5 11.75" />
      </template>
      <!-- Undo: a counter-clockwise arrow. -->
      <template v-else-if="glyph.shape === 'undo'">
        <path d="M3.25 8a4.75 4.75 0 101.6-3.55" />
        <path d="M3 2.75v3h3" />
      </template>
      <!-- Select all loaded: two checked boxes. -->
      <template v-else-if="glyph.shape === 'select-all-loaded'">
        <path d="M2.75 3.75h3.5v3.5h-3.5zM2.75 8.75h3.5v3.5h-3.5z" />
        <path d="M8.75 5.5h4.5M8.75 10.5h4.5" />
      </template>
      <!-- Clear selection: an emptied box. -->
      <template v-else-if="glyph.shape === 'clear-selection'">
        <rect x="2.75" y="2.75" width="10.5" height="10.5" rx="1.5" />
        <path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" />
      </template>
      <!-- Splits: two panes. -->
      <template v-else-if="glyph.shape === 'split'">
        <rect x="2.5" y="3.25" width="11" height="9.5" rx="1.5" />
        <path d="M8 3.25v9.5" />
      </template>
      <!-- Unread-only filter: a funnel. -->
      <path v-else-if="glyph.shape === 'filter'" d="M2.75 3.75h10.5L9.5 8.4v3.85l-3-1.5V8.4z" />
      <!-- Sync now: two chasing arrows. -->
      <template v-else-if="glyph.shape === 'sync'">
        <path d="M13 6.25A5 5 0 004.1 4.6L3 6" />
        <path d="M3 2.75V6h3.25" />
        <path d="M3 9.75A5 5 0 0011.9 11.4L13 10" />
        <path d="M13 13.25V10H9.75" />
      </template>
      <!-- Switch account: two opposing arrows. -->
      <template v-else>
        <path d="M2.75 5.25h9.5M9.5 2.5l2.75 2.75L9.5 8" />
        <path d="M13.25 10.75h-9.5M6.5 8l-2.75 2.75L6.5 13.5" />
      </template>
    </svg>
  </span>
</template>
