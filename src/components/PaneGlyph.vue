<script setup lang="ts">
/**
 * Local inline 16px glyphs for the side panes: the icon rail (destinations and
 * utilities) and the contact pane (section label, copy controls). Sibling of
 * HeaderGlyph and RowGlyph: no icon font, no CDN. Purely decorative: every
 * glyph is aria-hidden and its control carries the accessible name in text.
 */
defineProps<{
  name: 'inbox' | 'done' | 'provider' | 'trash' | 'account' | 'activity' | 'drafts' | 'contact' | 'mail' | 'copy';
}>();
</script>

<template>
  <svg
    class="pane-glyph"
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
    <!-- Inbox: an in-tray. -->
    <template v-if="name === 'inbox'">
      <path d="M2.5 9.25V12a1 1 0 001 1h9a1 1 0 001-1V9.25L11.6 3.8a1 1 0 00-.94-.55H5.34a1 1 0 00-.94.55z" />
      <path d="M2.5 9.25h3l.9 1.75h3.2l.9-1.75h3" />
    </template>
    <!-- Cached Done: the same check as the row Done action. -->
    <path v-else-if="name === 'done'" d="M3.25 8.5l3.1 3.1 6.4-7.2" />
    <!-- Provider mail (labels and folders, read only): a folder. -->
    <path v-else-if="name === 'provider'" d="M2.5 4.25a1 1 0 011-1h2.65l1.4 1.5h4.95a1 1 0 011 1V12a1 1 0 01-1 1h-9a1 1 0 01-1-1z" />
    <!-- Cached Trash: a bin. -->
    <template v-else-if="name === 'trash'">
      <path d="M2.75 4.5h10.5M6.25 4.5V3h3.5v1.5" />
      <path d="M4.25 4.5l.6 8.1a1 1 0 001 .9h4.3a1 1 0 001-.9l.6-8.1" />
      <path d="M6.75 7v3.75M9.25 7v3.75" />
    </template>
    <!-- Account: a person in a circle. -->
    <template v-else-if="name === 'account'">
      <circle cx="8" cy="8" r="5.75" />
      <circle cx="8" cy="6.6" r="1.9" />
      <path d="M4.35 12.35a4.25 4.25 0 017.3 0" />
    </template>
    <!-- Activity (operation outcomes): a pulse line. -->
    <path v-else-if="name === 'activity'" d="M1.75 8.25h2.6l1.65-4 3.5 8 1.6-4h3.15" />
    <!-- Local drafts: a pencil. -->
    <template v-else-if="name === 'drafts'">
      <path d="M10.6 2.9l2.5 2.5-6.9 6.9-3.2.75.75-3.2z" />
      <path d="M9.1 4.4l2.5 2.5" />
    </template>
    <!-- Contact disclosure (narrow viewports): a contact card. -->
    <template v-else-if="name === 'contact'">
      <rect x="2.25" y="3.5" width="11.5" height="9" rx="1" />
      <circle cx="6" cy="7.1" r="1.35" />
      <path d="M3.95 10.6a2.25 2.25 0 014.1 0M9.75 6.75h2M9.75 9h2" />
    </template>
    <!-- Mail section label in the contact pane: an envelope. -->
    <template v-else-if="name === 'mail'">
      <rect x="2.25" y="3.75" width="11.5" height="8.5" rx="1" />
      <path d="M2.75 4.5L8 8.4l5.25-3.9" />
    </template>
    <!-- Copy: two overlapping sheets. -->
    <template v-else>
      <rect x="5.5" y="5.5" width="7.75" height="7.75" rx="1.25" />
      <path d="M3.75 10.5h-.25a.75.75 0 01-.75-.75V3.5a.75.75 0 01.75-.75h6.25a.75.75 0 01.75.75v.25" />
    </template>
  </svg>
</template>
