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
  <aside class="contact-pane" aria-label="Contact context" data-test="contact-pane">
    <h2 class="contact-title">{{ props.context === 'focused' ? 'Focused conversation' : 'Open conversation' }}</h2>
    <p v-if="props.contact" class="contact-identity" data-test="contact-identity">
      <span class="contact-name" data-test="contact-name">{{ nameLabel(props.contact) }}</span>
      <button
        v-if="props.contact.displayName"
        type="button"
        class="contact-copy"
        data-test="copy-name"
        @click="copyValue('name', props.contact.displayName)"
      >Copy name</button>
      <span v-if="props.contact.displayName" class="contact-mailbox" data-test="contact-mailbox">{{ props.contact.mailbox }}</span>
      <button
        type="button"
        class="contact-copy"
        data-test="copy-email"
        @click="copyValue('email', props.contact.mailbox)"
      >Copy email</button>
    </p>
    <p v-else class="contact-unknown" data-test="contact-unknown">
      No correspondent information is available.
    </p>
    <p
      v-if="copyOutcome"
      class="contact-copy-status"
      role="status"
      data-test="copy-status"
      :data-copy-ok="copyOutcome.ok ? 'true' : 'false'"
    >{{ copyOutcome.message }}</p>
  </aside>
</template>
