<script setup lang="ts">
/**
 * Local inline 16px split-header glyphs, sibling of RowGlyph (no icon font,
 * no CDN). Purely decorative: every glyph is aria-hidden and its button
 * carries the accessible name in visually hidden text.
 */
defineProps<{
  name: 'menu' | 'more' | 'search' | 'commands' | 'settings' | 'star' | 'back' | 'remind' | 'reminders' | 'x' | 'compose' | 'done' | 'files' | 'reply' | 'read' | 'unread' | 'prev' | 'next' | 'copy' | 'collapse' | 'contact' | 'prompt' | 'select';
  /** Star only: a filled star for the pressed (filter on) state. */
  filled?: boolean;
}>();
</script>

<template>
  <svg
    class="header-glyph-icon"
    width="16"
    height="16"
    :data-glyph="name"
    :viewBox="name === 'select' ? '0 0 24 24' : '0 0 16 16'"
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
    <template v-else-if="name === 'more'">
      <circle cx="3.25" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="12.75" cy="8" r="1" fill="currentColor" stroke="none" />
    </template>
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
    <template v-else-if="name === 'copy'">
      <path d="M5.75 5.75h6.5a1 1 0 011 1v6.5a1 1 0 01-1 1h-6.5a1 1 0 01-1-1v-6.5a1 1 0 011-1z" />
      <path d="M11.25 3.75v-.5a1 1 0 00-1-1h-6.5a1 1 0 00-1 1v6.5a1 1 0 001 1h.5" />
    </template>
    <path v-else-if="name === 'collapse'" d="M4.5 3.25L8 6.5l3.5-3.25M4.5 12.75L8 9.5l3.5 3.25" />
    <template v-else-if="name === 'contact'">
      <circle cx="8" cy="5.5" r="2.5" />
      <path d="M3 13.25c.6-2.4 2.6-3.75 5-3.75s4.4 1.35 5 3.75" />
    </template>
    <path v-else-if="name === 'prompt'" d="M3.5 5l3 3-3 3M8.5 11.25h4" />
    <!-- Starred only filter: outline at rest, filled while the filter is on. -->
    <template v-else-if="name === 'settings'">
      <circle cx="8" cy="8" r="2.1" />
      <circle cx="8" cy="8" r="5.1" />
      <path d="M8 1.2v1.4M8 13.4v1.4M1.2 8h1.4M13.4 8h1.4M3.2 3.2l1 1M11.8 11.8l1 1M12.8 3.2l-1 1M4.2 11.8l-1 1" />
    </template>
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
    <template v-else-if="name === 'select'">
      <rect x="3" y="3" width="18" height="18" rx="4" stroke-width="2" />
      <path d="m7.5 12 3 3 6-6" stroke-width="2" />
    </template>
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
    <!-- The Reminders view (the list): a bell, so it never reads as the clock of "Remind me". -->
    <template v-else-if="name === 'reminders'">
      <path d="M4 11V7a4 4 0 018 0v4l1.25 1.5H2.75L4 11z" />
      <path d="M6.75 14.5h2.5" />
    </template>
    <!-- Remind me (an action on this conversation): a clock, like the row action. -->
    <template v-else>
      <circle cx="8" cy="8" r="5.25" />
      <path d="M8 5.25V8l1.9 1.4" />
    </template>
  </svg>
</template>
