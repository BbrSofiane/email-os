<script setup lang="ts">
/**
 * Gmail account status and lifecycle controls (Slice 02).
 *
 * Read-only disclosure is explicit: Gmail mode never offers archive, mark-read, or
 * sending. `connect_account`/`disconnect_account`/`request_sync` enqueue work and
 * return acceptance, so button state follows the authoritative AccountStatus (plus a
 * transient busy flag), never an invented OAuth/sync success. Failures stay typed
 * and visible; the cached list/reader remain usable while sync is offline or
 * sign-in is required.
 *
 * Safety: plain text interpolation only — no HTML, no remote assets, no URLs.
 */
import type { AccountStatus, ConnectionState, MailError } from '../lib/ipc/client';
import type { AccountAction } from '../composables/useMailbox';

const props = defineProps<{
  status: AccountStatus;
  /** Transient in-flight lifecycle action, if any. */
  busy: AccountAction | null;
}>();

const emit = defineEmits<{
  connect: [];
  disconnect: [];
  sync: [];
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
      <span class="account-mode" data-test="account-mode">Gmail — read-only</span>
      <span class="account-connection" data-test="account-connection">{{ connectionLabel(props.status.connection) }}</span>
    </div>
    <p v-if="props.status.account" class="account-email" data-test="account-email">
      {{ props.status.account.emailAddress }}
    </p>
    <p class="account-disposable" data-test="disposable-account-note">
      Disposable test account — read-only access only.
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
        :disabled="props.busy !== null"
        @click="emit('connect')"
      >
        {{ props.status.connection === 'auth_required' ? 'Sign in again' : 'Connect' }}
      </button>
      <button
        v-if="props.status.account !== null || props.status.connection === 'auth_required' || props.status.connection === 'authenticating'"
        type="button"
        data-test="account-disconnect"
        :disabled="props.busy !== null"
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
