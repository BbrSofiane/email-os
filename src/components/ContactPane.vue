<script setup lang="ts">
/**
 * Contact context pane (UX-01/UX-02). Renders only the exact known correspondent
 * fields with interpolation: a display name when present, otherwise the bare
 * mailbox. A missing correspondent is disclosed, never guessed from the
 * participant list, and no profile data is fabricated or fetched on focus.
 *
 * Copy controls (UX-02) copy exactly the displayed name/address through
 * navigator.clipboard.writeText ONLY after an explicit activation. Copying
 * never triggers a draft, navigation, or any mailbox write; when clipboard
 * access is unavailable the text stays selectable and an honest manual-copy
 * notice is reported accessibly. Outcomes are announced via role="status".
 */
import { computed, ref, watch } from 'vue';
import type { ConversationRef } from '../lib/ipc/client';
import PaneGlyph from './PaneGlyph.vue';

export interface ContactInfo {
  displayName: string | null;
  mailbox: string;
}

const props = withDefaults(defineProps<{
  /** Exact known correspondent, or `null` when nothing is known. */
  contact: ContactInfo | null;
  /** Which surface the contact belongs to; disclosed for clarity. */
  context: 'focused' | 'open';
  recent?: { ref: ConversationRef; subject: string }[];
  /** Reply target while a draft editor is active; `null` renders no compose line. */
  composeTarget?: ContactInfo | null;
  /** The open conversation is still loading: an absent contact is not yet known, not absent. */
  loading?: boolean;
}>(), { composeTarget: null });

const emit = defineEmits<{ searchSender: [mailbox: string]; openRecent: [ref: ConversationRef] }>();

type CopyOutcome = { ok: true; message: string } | { ok: false; message: string };
const copyOutcome = ref<CopyOutcome | null>(null);
/** Monotonic activation token: only the newest activation may publish an outcome. */
let activationToken = 0;

/**
 * Displayed identity/context fence key. Outcomes are fenced on the contact
 * identity and surface context shown at activation time: a delayed older
 * completion must never publish under a different displayed contact/context.
 */
const displayedKey = computed(() => {
  const contact = props.contact;
  const identity = contact ? `${contact.displayName ?? ''}\u0000${contact.mailbox}` : 'unknown';
  return `${props.context}\u0000${identity}`;
});

// When the displayed contact or context changes, the previously reported
// outcome no longer describes what the user sees: clear it immediately.
watch(displayedKey, () => { copyOutcome.value = null; });

function nameLabel(contact: ContactInfo): string {
  return contact.displayName ?? contact.mailbox;
}

async function copyValue(label: 'name' | 'email', value: string): Promise<void> {
  const token = ++activationToken;
  const fenceKey = displayedKey.value;
  // A new activation resets the reported status and owns the next outcome.
  copyOutcome.value = null;
  const publish = (outcome: CopyOutcome): void => {
    // Fence: a delayed older completion must not publish under a different
    // displayed contact/context or replace a newer activation's outcome.
    if (token !== activationToken || displayedKey.value !== fenceKey) return;
    copyOutcome.value = outcome;
  };
  const clipboard = navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    publish({
      ok: false,
      message: `Clipboard access is unavailable here. Select the ${label} text and copy it manually.`,
    });
    return;
  }
  try {
    await clipboard.writeText(value);
    publish({ ok: true, message: `${label === 'name' ? 'Name' : 'Email address'} copied.` });
  } catch {
    publish({
      ok: false,
      message: `Copying the ${label} failed. The text stays selectable for a manual copy.`,
    });
  }
}
</script>

<template>
  <!-- Layout (DESIGN.md "Contact Pane"): no visible caption (the context
       heading stays in the accessibility tree); the name sits on the split-tab
       line, the email on the first list line, each with a trailing copy glyph
       that is revealed on hover/focus without reserving a line of its own.
       Recent cached mail is plain text rows at a 24px pitch. In the wide
       column those lines are pinned to the list's geometry (style.css
       .contact-column); inside the narrow disclosure they stack compactly. -->
  <aside class="contact-pane" aria-label="Contact context" data-test="contact-pane">
    <h2 class="contact-title visually-hidden">{{ props.context === 'focused' ? 'Focused conversation' : 'Open conversation' }}</h2>
    <p v-if="props.composeTarget" class="compose-target" data-test="compose-target">Composing to {{ props.composeTarget.displayName ?? props.composeTarget.mailbox }} <span class="compose-target-mail">{{ props.composeTarget.mailbox }}</span></p>
    <div v-if="props.contact" class="contact-identity" data-test="contact-identity">
      <p class="contact-line contact-line-name">
        <button type="button" class="contact-name contact-search" data-test="contact-name" title="Find mail from this sender" @click="emit('searchSender', props.contact.mailbox)">{{ nameLabel(props.contact) }}</button>
        <button
          v-if="props.contact.displayName"
          type="button"
          class="contact-copy"
          data-test="copy-name"
          title="Copy name"
          @click="copyValue('name', props.contact.displayName)"
        ><PaneGlyph name="copy" /><span class="visually-hidden">Copy name</span></button>
        <!-- Without a display name the name line IS the address: copy it here. -->
        <button
          v-else
          type="button"
          class="contact-copy"
          data-test="copy-email"
          title="Copy email"
          @click="copyValue('email', props.contact.mailbox)"
        ><PaneGlyph name="copy" /><span class="visually-hidden">Copy email</span></button>
      </p>
      <p v-if="props.contact.displayName" class="contact-line contact-line-mailbox">
        <span class="contact-mailbox" data-test="contact-mailbox">{{ props.contact.mailbox }}</span>
        <button
          type="button"
          class="contact-copy"
          data-test="copy-email"
          title="Copy email"
          @click="copyValue('email', props.contact.mailbox)"
        ><PaneGlyph name="copy" /><span class="visually-hidden">Copy email</span></button>
      </p>
    </div>
    <p v-else-if="!props.loading" class="contact-unknown" data-test="contact-unknown">
      No correspondent information is available.
    </p>
    <section v-if="props.contact && props.recent?.length" class="contact-recent" aria-label="Recent cached mail from sender">
      <h3><PaneGlyph name="mail" /><span>Recent cached mail</span></h3>
      <ul><li v-for="item in props.recent" :key="item.ref.accountId + item.ref.conversationId"><button type="button" :title="item.subject || '(No subject)'" @click="emit('openRecent', item.ref)">{{ item.subject || '(No subject)' }}</button></li></ul>
    </section>
    <p
      v-if="copyOutcome"
      class="contact-copy-status"
      role="status"
      data-test="copy-status"
      :data-copy-ok="copyOutcome.ok ? 'true' : 'false'"
    >{{ copyOutcome.message }}</p>
  </aside>
</template>

<style scoped>
/* Compose context line shown while a reply draft editor is active. Plain text
   interpolation only, on the existing shell text tokens. */
.compose-target {
  margin: 0;
  font-size: var(--type-body);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.compose-target-mail {
  color: var(--text-tertiary);
}
</style>
