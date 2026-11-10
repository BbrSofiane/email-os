<script setup lang="ts">
/**
 * Gmail account status and lifecycle controls (Slices 02 + 03).
 *
 * Gmail remains read-only until authoritative `mutationAccess: enabled`; the explicit
 * upgrade disclosure explains Google's broader modify scope. Lifecycle commands
 * return acceptance, so button state follows the authoritative AccountStatus (plus a
 * transient busy flag), never an invented OAuth/sync success. Failures stay typed
 * and visible; the cached list/reader remain usable while sync is offline or
 * sign-in is required.
 *
 * Layout: four labelled sections (connection, sync, permissions, session)
 * separated by spacing only; the drawer supplies the "Account" heading. A fact
 * appears only where it is real: no permission mode before there is an account,
 * no Sync section when there is nothing to sync, and a failed sync is said once
 * (the error line with Retry), not as a state word plus a sentence.
 * Disconnect is destructive, so it asks in place and the warning is not in the
 * DOM until it is asked for. Cancelling a sign-in has nothing to lose and stays
 * one click.
 *
 * Safety: plain text interpolation only — no HTML, no remote assets, no URLs.
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { AccountStatus, ConnectionState, MailError } from '../lib/ipc/client';
import type { AccountAction } from '../composables/useMailbox';
import { NOT_CONFIGURED_HINT, describeMailError, describeSyncFailure } from '../lib/account-status';
import FullDate from './FullDate.vue';

const props = defineProps<{
  status: AccountStatus;
  /** Transient in-flight lifecycle action, if any. */
  busy: AccountAction | null;
  transitioning?: boolean;
  actionError?: MailError | null;
}>();

const emit = defineEmits<{
  connect: [];
  disconnect: [];
  sync: [];
  enableActions: [];
  cancelUpgrade: [];
}>();

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  not_configured: 'Not configured',
  disconnected: 'Not connected',
  authenticating: 'Signing in…',
  connected: 'Connected',
  auth_required: 'Sign-in expired',
};

const MODE_TITLE = 'Cached reading remains available during permission changes.';
const DISCONNECT_WARNING = "Removes pending actions and the mail cache from this device. Local drafts stay and return if you reconnect the same account. Confirmed Gmail changes are not undone and Google's grant is not revoked.";

const access = computed(() => props.status.mutationAccess ?? 'read_only');
const sync = computed(() => props.status.sync);
const connection = computed(() => props.status.connection);

const modeLabel = computed(() => {
  switch (access.value) {
    case 'read_only': return 'Gmail · read-only';
    case 'upgrading': return 'Gmail · permission request pending';
    case 'enabled': return 'Gmail · mailbox actions enabled';
  }
});

/** A grant or a cache exists only once an account has been (or is being) connected. */
const hasAccountFacts = computed(() => connection.value === 'connected' || connection.value === 'auth_required');
const modeShown = hasAccountFacts;
const syncShown = hasAccountFacts;

const firstSyncRunning = computed(() => sync.value.state === 'syncing' && !sync.value.initialSyncComplete);
/** The inline error line with Retry says the failure; the state word is then dropped, not repeated. */
const errorLine = computed(() => sync.value.state === 'error' && sync.value.error ? describeSyncFailure(sync.value.error) : '');
const syncLabel = computed(() => {
  if (sync.value.state === 'error') return 'Failed';
  if (sync.value.state === 'syncing') return firstSyncRunning.value ? 'Syncing first mail…' : 'Syncing…';
  return 'Idle';
});
const cachedLabel = computed(() => {
  const count = sync.value.cachedConversations;
  if (firstSyncRunning.value) return `${count} cached`;
  return `${count} ${count === 1 ? 'conversation' : 'conversations'} cached`;
});
/**
 * The bounded-coverage fact, once, as a short second line. It describes a cache,
 * so it is absent with nothing cached and when the account is not connected
 * (a disconnect clears the cache; it would only describe an empty one).
 */
const coverageText = computed(() => sync.value.coverageLimit > 0
  && sync.value.cachedConversations > 0
  && (connection.value === 'connected' || connection.value === 'auth_required')
  ? `Up to ${sync.value.coverageLimit} conversations are cached; older mail may be missing.`
  : '');
/** The inline Retry beside the error covers Sync now; without a typed error there is no Retry. */
const retryShown = computed(() => errorLine.value !== '');

const showConnect = computed(() => connection.value === 'not_configured' || connection.value === 'disconnected' || connection.value === 'auth_required');
const canEnable = computed(() => access.value === 'read_only' && connection.value === 'connected');
const showPermissions = computed(() => canEnable.value || access.value === 'upgrading' || access.value === 'enabled');
const showSession = computed(() => props.status.account !== null || connection.value === 'auth_required' || connection.value === 'authenticating');

// Two-step disconnect. Focus moves to the safe choice on open and back on cancel.
const confirming = ref(false);
const askButton = ref<HTMLButtonElement | null>(null);
const keepButton = ref<HTMLButtonElement | null>(null);

async function askDisconnect(): Promise<void> {
  confirming.value = true;
  await nextTick();
  keepButton.value?.focus();
}
async function keepAccount(): Promise<void> {
  confirming.value = false;
  await nextTick();
  askButton.value?.focus();
}
function confirmKeydown(event: KeyboardEvent): void {
  // Esc answers "keep" and is consumed here so it never also closes the drawer.
  if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  event.stopPropagation();
  void keepAccount();
}
watch(() => props.status.account, (account) => { if (!account) confirming.value = false; });
watch(connection, (next) => { if (next === 'authenticating') confirming.value = false; });
// A failed disconnect leaves the question open (with its error above); success removes the account and this section.
</script>

<template>
  <section class="account-panel" aria-label="Account" data-test="account-panel">
    <div class="account-section">
      <h3 class="account-label">Connection</h3>
      <p class="account-line account-connection-line">
        <template v-if="props.status.account"><span data-test="account-email">{{ props.status.account.emailAddress }}</span> · </template><span data-test="account-connection">{{ CONNECTION_LABELS[connection] }}</span>
      </p>
      <p v-if="modeShown" class="account-line account-mode" data-test="account-mode" :title="MODE_TITLE">{{ modeLabel }}</p>
      <p v-if="props.actionError" class="account-action-error" data-test="account-action-error" role="alert">
        Mailbox-action request: {{ describeMailError(props.actionError) }}
      </p>
      <p v-if="connection === 'not_configured'" class="account-notice" data-test="account-not-configured" role="note">
        Gmail is not configured on this device. {{ NOT_CONFIGURED_HINT }}
      </p>
      <p v-if="connection === 'auth_required'" class="account-notice" data-test="account-auth-required" role="note">
        Cached mail stays readable. Sign in again to sync.
      </p>
      <div v-if="showConnect" class="account-actions">
        <button
          type="button"
          data-test="account-connect"
          :disabled="props.busy !== null || props.transitioning"
          @click="emit('connect')"
        >
          {{ connection === 'auth_required' ? 'Sign in again' : 'Connect Gmail' }}
        </button>
      </div>
    </div>

    <div v-if="syncShown" class="account-section">
      <h3 class="account-label">Sync</h3>
      <p class="account-line account-sync-line">
        <template v-if="!retryShown">
          <span data-test="account-sync-state">{{ syncLabel }}</span>
          <span class="account-sep" aria-hidden="true">·</span>
        </template>
        <span data-test="account-last-synced"><template v-if="sync.lastSyncedAt">Last synced <FullDate :at="sync.lastSyncedAt" /></template><template v-else>Never synced</template></span>
        <span class="account-sep" aria-hidden="true">·</span>
        <span data-test="account-cached">{{ cachedLabel }}</span>
      </p>
      <p v-if="coverageText" class="account-note" data-test="account-coverage">{{ coverageText }}</p>
      <p v-if="connection === 'connected' && sync.state === 'idle' && !sync.initialSyncComplete" class="account-note" data-test="account-initial-sync">
        Initial sync has not finished.
      </p>
      <p
        v-if="retryShown"
        class="account-sync-error"
        data-test="account-sync-error"
        role="alert"
      >
        <span>{{ errorLine }}</span>
        <button
          type="button"
          data-test="account-sync-retry"
          :disabled="props.busy !== null"
          @click="emit('sync')"
        >Retry</button>
      </p>
      <div v-if="connection === 'connected' && !retryShown" class="account-actions">
        <button
          type="button"
          data-test="account-sync"
          :disabled="props.busy !== null || sync.state === 'syncing'"
          @click="emit('sync')"
        >
          Sync now
        </button>
      </div>
    </div>

    <div v-if="showPermissions" class="account-section">
      <h3 class="account-label">Permissions</h3>
      <template v-if="canEnable">
        <p class="account-note" data-test="action-upgrade-disclosure" role="note">
          Enable mailbox actions asks Google for its broad Gmail modify permission, which can also allow sending and deleting mail. Email OS only marks done, marks read and stars; it never sends or deletes.
        </p>
        <div class="account-actions">
          <button
            type="button"
            data-test="enable-mailbox-actions"
            :disabled="props.busy !== null"
            @click="emit('enableActions')"
          >
            {{ props.busy === 'enable-actions' ? 'Requesting permission…' : 'Enable mailbox actions' }}
          </button>
        </div>
      </template>
      <template v-else-if="access === 'upgrading'">
        <p class="account-line" data-test="action-upgrading" role="status">
          Finish sign-in in your browser. Cached mail stays readable.
        </p>
        <div class="account-actions">
          <button
            type="button"
            class="account-primary"
            data-test="cancel-action-upgrade"
            :disabled="props.busy !== null"
            @click="emit('cancelUpgrade')"
          >
            {{ props.busy === 'cancel-upgrade' ? 'Canceling permission request…' : 'Cancel permission request' }}
          </button>
        </div>
      </template>
      <p v-else-if="access === 'enabled'" class="account-line" data-test="actions-enabled" role="status">
        Mailbox actions are enabled.
      </p>
    </div>

    <div v-if="showSession" class="account-section">
      <h3 class="account-label">Session</h3>
      <div v-if="connection === 'authenticating'" class="account-actions">
        <button
          type="button"
          data-test="account-disconnect"
          :disabled="props.busy !== null || props.transitioning"
          @click="emit('disconnect')"
        >
          Cancel sign-in
        </button>
      </div>
      <div v-else-if="!confirming" class="account-actions">
        <button
          ref="askButton"
          type="button"
          class="drawer-ghost"
          data-test="account-disconnect"
          :disabled="props.busy !== null || props.transitioning"
          @click="askDisconnect()"
        >
          Disconnect…
        </button>
      </div>
      <div v-else class="account-confirm" @keydown="confirmKeydown">
        <p class="account-note" data-test="disconnect-warning" role="note">{{ DISCONNECT_WARNING }}</p>
        <div class="account-actions">
          <button
            type="button"
            class="account-destructive"
            data-test="account-disconnect-confirm"
            :disabled="props.busy !== null || props.transitioning"
            @click="emit('disconnect')"
          >
            Disconnect
          </button>
          <button
            ref="keepButton"
            type="button"
            class="account-primary"
            data-test="account-disconnect-cancel"
            @click="keepAccount()"
          >
            Keep account
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
