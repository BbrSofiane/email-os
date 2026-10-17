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
 * Safety: plain text interpolation only — no HTML, no remote assets, no URLs.
 */
import type { AccountStatus, ConnectionState, MailError, MutationAccess } from '../lib/ipc/client';
import type { AccountAction } from '../composables/useMailbox';

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
  disconnected: 'Disconnected',
  authenticating: 'Signing in…',
  connected: 'Connected',
  auth_required: 'Sign-in required',
};

const SYNC_LABELS: Record<AccountStatus['sync']['state'], string> = {
  idle: 'Idle',
  syncing: 'Syncing…',
  error: 'Sync error',
};

function connectionLabel(connection: ConnectionState): string {
  return CONNECTION_LABELS[connection];
}

function accessLabel(access: MutationAccess | undefined): string {
  switch (access ?? 'read_only') {
    case 'read_only': return 'read-only';
    case 'upgrading': return 'Permission upgrade in progress';
    case 'enabled': return 'Mailbox actions enabled';
  }
}

function describeError(error: MailError): string {
  switch (error.kind) {
    case 'not_configured':
      return 'Gmail is not configured on this device.';
    case 'auth_required':
      return 'Sign-in is required to continue syncing.';
    case 'auth_cancelled':
      return 'Sign-in was cancelled.';
    case 'auth_failed':
      return 'Sign-in failed.';
    case 'secrets_unavailable':
      return 'Secure credential storage is unavailable.';
    case 'network_unavailable':
      return 'The network is unavailable.';
    case 'rate_limited':
      return 'The provider is rate limiting; retrying with backoff.';
    case 'provider_unavailable':
      return 'The mail provider is temporarily unavailable.';
    case 'invalid_provider_response':
      return 'The provider returned an unexpected response.';
    case 'busy':
      return 'A sync is already in progress.';
    case 'permission_required':
      return 'Google did not grant mailbox-action permission; the account remains read-only.';
    case 'provider_rejected':
      return 'The provider rejected the mailbox action.';
    case 'outcome_unknown':
      return 'The provider outcome is unknown; review Activity before retrying.';
    case 'read_only':
      return 'Gmail is read-only; this action is unavailable.';
    case 'storage_unavailable':
      return 'Local storage is unavailable.';
    case 'not_found':
      return 'Not found.';
    case 'invalid_request':
      return 'Invalid request.';
    case 'request_id_conflict':
      return 'Conflicting request.';
    case 'profile_in_use':
      return 'The profile is in use by another window.';
    default:
      return 'unknown error';
  }
}

function formatLastSynced(at: string | null): string {
  if (!at) return 'Never synced';
  return `Last synced ${at}`;
}

function coverageText(): string {
  const sync = props.status.sync;
  if (!sync.initialSyncComplete) {
    return sync.coverageLimit > 0
      ? `Initial sync in progress: ${sync.cachedConversations} conversations cached; coverage is bounded to ${sync.coverageLimit} discovered conversations and may be incomplete.`
      : `Initial sync in progress: ${sync.cachedConversations} conversations cached so far.`;
  }
  if (sync.coverageLimit > 0) {
    return `The cached inbox view contains up to ${sync.coverageLimit} discovered conversations; additional inbox threads may be omitted.`;
  }
  return '';
}

const showConnect = (): boolean =>
  props.status.connection === 'not_configured' ||
  props.status.connection === 'disconnected' ||
  props.status.connection === 'auth_required';
</script>

<template>
  <section class="account-panel" aria-label="Account" data-test="account-panel">
    <div class="account-row">
      <span class="account-mode" data-test="account-mode">Gmail — {{ accessLabel(props.status.mutationAccess) }}</span>
      <span class="account-connection" data-test="account-connection">{{ connectionLabel(props.status.connection) }}</span>
    </div>
    <p v-if="props.status.account" class="account-email" data-test="account-email">
      {{ props.status.account.emailAddress }}
    </p>
    <p class="account-disposable" data-test="disposable-account-note">
      Disposable test account. Cached reading remains available during permission changes.
    </p>
    <p v-if="props.actionError" class="account-action-error" data-test="account-action-error" role="alert">
      Mailbox-action request: {{ describeError(props.actionError) }}
    </p>
    <template v-if="(props.status.mutationAccess ?? 'read_only') === 'read_only' && props.status.connection === 'connected'">
      <p class="account-upgrade-disclosure" data-test="action-upgrade-disclosure" role="note">
        Enable mailbox actions requests Google's broad Gmail modify permission, which can also allow sending and deleting mail.
        Email OS currently implements only archive/unarchive and explicit read/unread; it does not send or delete mail.
      </p>
      <button
        type="button"
        data-test="enable-mailbox-actions"
        :disabled="props.busy !== null"
        @click="emit('enableActions')"
      >
        {{ props.busy === 'enable-actions' ? 'Requesting permission…' : 'Enable mailbox actions' }}
      </button>
    </template>
    <p v-else-if="props.status.mutationAccess === 'upgrading'" data-test="action-upgrading" role="status">
      Google permission upgrade in progress. Mail remains readable; actions stay disabled until access is verified.
    </p>
    <p v-else-if="props.status.mutationAccess === 'enabled'" data-test="actions-enabled" role="status">
      Mailbox actions are enabled for this account.
    </p>
    <button
      v-if="props.status.mutationAccess === 'upgrading'"
      type="button"
      data-test="cancel-action-upgrade"
      :disabled="props.busy !== null"
      @click="emit('cancelUpgrade')"
    >
      {{ props.busy === 'cancel-upgrade' ? 'Canceling permission request…' : 'Cancel permission upgrade' }}
    </button>
    <p class="account-disconnect-warning" data-test="disconnect-warning" role="note">
      Disconnect removes local pending actions and mail cache, but local drafts remain on this device and are accessible after reconnecting the same account. It does not undo confirmed Gmail changes or revoke Google's grant.
    </p>
    <p v-if="props.status.connection === 'not_configured'" class="account-notice" data-test="account-not-configured" role="note">
      Gmail is not configured on this device: no Google client credentials were found, so connecting is unavailable.
    </p>
    <p v-if="props.status.connection === 'auth_required'" class="account-notice" data-test="account-auth-required" role="note">
      Sign-in has expired. Cached conversations stay readable; reconnect to sync new mail.
    </p>
    <div class="account-row">
      <span class="account-sync" data-test="account-sync-state">{{ SYNC_LABELS[props.status.sync.state] }}</span>
      <span class="account-last-synced" data-test="account-last-synced">{{ formatLastSynced(props.status.sync.lastSyncedAt) }}</span>
    </div>
    <p
      v-if="props.status.sync.state === 'error' && props.status.sync.error"
      class="account-sync-error"
      data-test="account-sync-error"
      role="alert"
    >
      Last sync failed: {{ describeError(props.status.sync.error) }}
    </p>
    <p v-if="coverageText()" class="account-coverage" data-test="account-coverage">
      {{ coverageText() }}
    </p>
    <p class="account-cached" data-test="account-cached">
      {{ props.status.sync.cachedConversations }} conversation(s) cached locally.
    </p>
    <div class="account-actions">
      <button
        v-if="showConnect()"
        type="button"
        data-test="account-connect"
        :disabled="props.busy !== null || props.transitioning"
        @click="emit('connect')"
      >
        {{ props.status.connection === 'auth_required' ? 'Sign in again' : 'Connect' }}
      </button>
      <button
        v-if="props.status.account !== null || props.status.connection === 'auth_required' || props.status.connection === 'authenticating'"
        type="button"
        data-test="account-disconnect"
        :disabled="props.busy !== null || props.transitioning"
        @click="emit('disconnect')"
      >
        {{ props.status.connection === 'authenticating' ? 'Cancel sign-in' : 'Disconnect' }}
      </button>
      <button
        v-if="props.status.connection === 'connected'"
        type="button"
        data-test="account-sync"
        :disabled="props.busy !== null || props.status.sync.state === 'syncing'"
        @click="emit('sync')"
      >
        Sync now
      </button>
    </div>
  </section>
</template>
