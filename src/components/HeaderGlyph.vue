<script setup lang="ts">
/**
 * Local inline 16px split-header glyphs, sibling of RowGlyph (no icon font,
 * no CDN). Purely decorative: every glyph is aria-hidden and its button
 * carries the accessible name in visually hidden text.
 */
defineProps<{
  name: 'menu' | 'search' | 'commands' | 'star' | 'back' | 'reminders' | 'x' | 'compose' | 'done' | 'files' | 'reply' | 'read' | 'unread' | 'prev' | 'next';
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
    <!-- Reader actions. Done: the same check as the row Done action. -->
    <path v-else-if="name === 'done'" d="M3.25 8.5l3.1 3.1 6.4-7.2" />
    <!-- Files and links: a paperclip. -->
    <path v-else-if="name === 'files'" d="M12.4 7.3l-4.6 4.6a2.6 2.6 0 01-3.7-3.7l5-5a1.75 1.75 0 012.5 2.5L6.9 10.5a.9.9 0 01-1.3-1.3L9.8 5" />
    <!-- Reply: a reply arrow. -->
    <path v-else-if="name === 'reply'" d="M6.75 3.5L2.75 7.5l4 4M2.75 7.5h5.5a5 5 0 015 5" />
    <!-- Mark read: an opened envelope. -->
    <template v-else-if="name === 'read'">
      <path d="M2.5 6.75L8 2.75l5.5 4V12a1 1 0 01-1 1h-9a1 1 0 01-1-1z" />
      <path d="M2.75 7.25L8 10.5l5.25-3.25" />
    </template>
    <!-- Mark unread: a closed envelope with a dot. -->
    <template v-else-if="name === 'unread'">
      <path d="M2.25 5.5v6.25a1 1 0 001 1h9.5a1 1 0 001-1V8" />
      <path d="M2.75 5.5l4.6 3.4a1 1 0 001.2 0" />
      <circle cx="12" cy="4" r="1.75" fill="currentColor" />
    </template>
    <!-- Previous / next conversation: chevrons. -->
    <path v-else-if="name === 'prev'" d="M3.75 10l4.25-4.25L12.25 10" />
    <path v-else-if="name === 'next'" d="M3.75 6l4.25 4.25L12.25 6" />
    <!-- Close/clear: an X. -->
    <path v-else-if="name === 'x'" d="M4 4l8 8M12 4l-8 8" />
    <!-- Local reminders: a clock. -->
    <template v-else>
      <circle cx="8" cy="8" r="5.25" />
      <path d="M8 5.25V8l1.9 1.4" />
    </template>
  </svg>
</template>
