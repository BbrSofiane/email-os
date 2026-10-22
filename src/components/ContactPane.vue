<script setup lang="ts">
/**
 * Contact context pane (UX-01). Renders only the exact known correspondent
 * fields with interpolation: a display name when present, otherwise the bare
 * mailbox. A missing correspondent is disclosed, never guessed from the
 * participant list, and no profile data is fabricated or fetched on focus.
 */
export interface ContactInfo {
  displayName: string | null;
  mailbox: string;
}

const props = defineProps<{
  /** Exact known correspondent, or `null` when nothing is known. */
  contact: ContactInfo | null;
  /** Which surface the contact belongs to; disclosed for clarity. */
  context: 'focused' | 'open';
}>();

function nameLabel(contact: ContactInfo): string {
  return contact.displayName ?? contact.mailbox;
}
</script>

<template>
  <aside class="contact-pane" aria-label="Contact context" data-test="contact-pane">
    <h2 class="contact-title">{{ props.context === 'focused' ? 'Focused conversation' : 'Open conversation' }}</h2>
    <p v-if="props.contact" class="contact-identity" data-test="contact-identity">
      <span class="contact-name" data-test="contact-name">{{ nameLabel(props.contact) }}</span>
      <span v-if="props.contact.displayName" class="contact-mailbox" data-test="contact-mailbox">{{ props.contact.mailbox }}</span>
    </p>
    <p v-else class="contact-unknown" data-test="contact-unknown">
      No correspondent information is available.
    </p>
  </aside>
</template>
