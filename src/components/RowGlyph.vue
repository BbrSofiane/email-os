<script setup lang="ts">
/**
 * Local inline 16px row glyphs (no icon font, no CDN). Purely decorative:
 * every glyph is aria-hidden and its control carries the accessible name.
 */
defineProps<{ name: 'archive' | 'restore' | 'mark-read' | 'mark-unread' | 'more' | 'attachment' | 'attachment-outline' | 'reminder' }>();
</script>

<template>
  <svg
    class="row-glyph"
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
    <!-- Done / archive: a check, the conversation leaves the Inbox. -->
    <path v-if="name === 'archive'" d="M3.25 8.5l3.1 3.1 6.4-7.2" />
    <!-- Restore to Inbox: a return arrow. -->
    <template v-else-if="name === 'restore'">
      <path d="M6.25 3.75L3 7l3.25 3.25" />
      <path d="M3.25 7h6.25a3.25 3.25 0 010 6.5H8" />
    </template>
    <template v-else-if="name === 'reminder'"><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.25 1.5" /></template>
    <!-- Mark read: an opened envelope. -->
    <template v-else-if="name === 'mark-read'">
      <path d="M2.5 6.75L8 3.25l5.5 3.5v5.5a1 1 0 01-1 1h-9a1 1 0 01-1-1z" />
      <path d="M2.75 7l5.25 3.25L13.25 7" />
    </template>
    <!-- Mark unread: a closed envelope with the unread dot. -->
    <template v-else-if="name === 'mark-unread'">
      <path d="M11 4H3.5a1 1 0 00-1 1v6.5a1 1 0 001 1h9a1 1 0 001-1V7.5" />
      <path d="M2.75 5.25L8 9l2.5-1.8" />
      <circle cx="13" cy="4" r="1.6" fill="currentColor" stroke="none" />
    </template>
    <!-- Attachment present: a paperclip (row indicator; the wrapping element
         carries the accessible name, like the read-state and star markers). -->
    <template v-else-if="name === 'attachment'">
      <path d="M14.29 7.37l-6.13 6.13a4 4 0 01-5.66-5.66l6.13-6.13a2.67 2.67 0 013.77 3.77l-6.13 6.13a1.33 1.33 0 01-1.89-1.89l5.66-5.65" />
    </template>
    <!-- Attachment state unknown: the same paperclip as a thin outline, the
         hollow counterpart of the solid glyph (mirrors the read marker's
         hollow ring); the wrapping element carries the accessible name. -->
    <template v-else-if="name === 'attachment-outline'">
      <path stroke-width="0.8" d="M14.29 7.37l-6.13 6.13a4 4 0 01-5.66-5.66l6.13-6.13a2.67 2.67 0 013.77 3.77l-6.13 6.13a1.33 1.33 0 01-1.89-1.89l5.66-5.65" />
    </template>
    <!-- More actions: a horizontal ellipsis. -->
    <template v-else>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </template>
  </svg>
</template>
