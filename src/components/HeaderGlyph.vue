<script setup lang="ts">
/**
 * Local inline 16px split-header glyphs, sibling of RowGlyph (no icon font,
 * no CDN). Purely decorative: every glyph is aria-hidden and its button
 * carries the accessible name in visually hidden text.
 */
defineProps<{
  name: 'menu' | 'search' | 'commands' | 'star' | 'back' | 'reminders' | 'compose';
  /** Star only: a filled star for the pressed (filter on) state. */
  filled?: boolean;
}>();
</script>

<template>
  <svg
    class="header-glyph-icon"
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <!-- Destinations: the hamburger. -->
    <path v-if="name === 'menu'" d="M2.75 4.25h10.5M2.75 8h10.5M2.75 11.75h10.5" />
    <!-- Find mail: a magnifier. -->
    <template v-else-if="name === 'search'">
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.25 10.25l3 3" />
    </template>
    <!-- Commands: the command-key loop. -->
    <path
      v-else-if="name === 'commands'"
      d="M10 4v8a2 2 0 1 0 2-2H4a2 2 0 1 0 2 2V4a2 2 0 1 0-2 2h8a2 2 0 1 0-2-2"
    />
    <!-- Starred only filter: outline at rest, filled while the filter is on. -->
    <path
      v-else-if="name === 'star'"
      d="M8 2.4l1.7 3.5 3.85.55-2.8 2.7.67 3.85L8 11.2 4.58 13l.67-3.85-2.8-2.7 3.85-.55z"
      :fill="filled ? 'currentColor' : 'none'"
    />
    <!-- Back to previous context: a left arrow. -->
    <template v-else-if="name === 'back'">
      <path d="M7 3.75L2.75 8 7 12.25" />
      <path d="M3 8h10.25" />
    </template>
    <!-- Compose: the pencil (local drafts). -->
    <template v-else-if="name === 'compose'">
      <path d="M10.6 2.9l2.5 2.5-6.9 6.9-3.2.75.75-3.2z" />
      <path d="M9.1 4.4l2.5 2.5" />
    </template>
    <!-- Local reminders: a clock. -->
    <template v-else>
      <circle cx="8" cy="8" r="5.25" />
      <path d="M8 5.25V8l1.9 1.4" />
    </template>
  </svg>
</template>
