<script setup lang="ts">
/**
 * The draft recovery and error lines, in flow and on the content inset. Each
 * line shows only while its state exists, with unchanged wording and hooks.
 * The Drafts list shows all of them above its rows; while an editor covers the
 * list, the app shows the list and subscription lines here so they stay
 * visible (close protection has its own banner then).
 */
import type { MailError } from '../lib/ipc/client';
import { describeDraftError } from '../lib/draft-errors';

defineProps<{
  suspendedEditor?: boolean;
  closeError?: string | null;
  closeSetupError?: string | null;
  closeRetryAvailable?: boolean;
  listError: MailError | null;
  subscriptionError: MailError | null;
  /** An unopenable or uncreatable draft (opening it failed). */
  createError?: MailError | null;
}>();
const emit = defineEmits<{ retryDraftSubscription: []; retryClose: []; retryCloseSetup: [] }>();
</script>

<template>
  <div class="draft-notices">
    <p v-if="suspendedEditor" role="alert" class="drawer-alert" data-test="suspended-editor">
      An editor from another account is suspended in memory. Its text is hidden and will not be saved to this account; return to the original account to resolve it.
    </p>
    <p v-if="closeError" role="alert" class="drawer-alert" data-test="draft-close-error">{{ closeError }}</p>
    <p v-if="closeSetupError" role="alert" class="drawer-alert" data-test="draft-close-setup-error">
      Close protection could not be initialized: {{ closeSetupError }}
      <button type="button" class="drawer-quiet" data-test="retry-close-setup" @click="emit('retryCloseSetup')">Retry close protection</button>
    </p>
    <p v-if="closeRetryAvailable" class="drawer-line"><button type="button" class="drawer-quiet" data-test="retry-close" @click="emit('retryClose')">Retry close request</button></p>
    <p v-if="listError" role="alert" class="drawer-alert" data-test="draft-list-error">Could not load drafts: {{ describeDraftError(listError) }}</p>
    <p v-if="subscriptionError" role="alert" class="drawer-alert" data-test="draft-subscription-error">
      Draft change notifications are unavailable; this list will refresh on reconnect and after local saves. {{ describeDraftError(subscriptionError) }}
      <button type="button" class="drawer-quiet" data-test="retry-draft-subscription" @click="emit('retryDraftSubscription')">Retry draft updates</button>
    </p>
    <p v-if="createError" role="alert" class="drawer-alert" data-test="draft-open-error">{{ describeDraftError(createError) }}</p>
  </div>
</template>
