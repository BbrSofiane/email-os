/**
 * Startup gate for the one-time retirement of a legacy fixture database
 * (ADR 0002 stage 4). The backend owns the state machine and every safety
 * property (verified backup before anything is removed, crash recovery); this
 * composable only reads where it stands, asks the user, and reports the result.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type { FixtureTransitionStatus, MailClient } from '../lib/ipc/client';

export type GatePhase =
  /** Asking the backend where the transition stands. */
  | 'checking'
  /** Nothing to disclose, or it finished: the app may start. */
  | 'clear'
  /** A legacy fixture database exists: tell the user and wait. */
  | 'disclosure'
  /** The user accepted; the backup and reset are running. */
  | 'working'
  /** The last attempt did not complete; nothing was lost. */
  | 'failed'
  /** The backend could not even say where it stands. */
  | 'unavailable';

/** The disclosure, verbatim: what starts fresh, what stays, where the backup is. */
export const DISCLOSURE_TITLE = 'Your demo mailbox is being renewed';
export const DISCLOSURE_PARAGRAPHS = (megabytes: number): string[] => [
  'Email OS now runs its demo mailbox on the same engine as Gmail. To switch, your existing demo mailbox history has to start fresh once.',
  'Starts fresh: Done and archive history, undo history, reminders and your saved split. The 18 sample conversations return to their original state.',
  'Stays exactly as it is: your local drafts.',
  `A backup of the old mailbox (about ${megabytes} MB) is kept in the “backups” folder inside the fixture profile in Email OS’s app data folder. Nothing is deleted until that backup has been checked.`,
];
export const DISCLOSURE_ACTION = 'Back up and start fresh';
export const DISCLOSURE_CANCEL_NOTE = 'To cancel, close this window. Nothing is changed, and you will be asked again next time.';

export function failureMessage(status: FixtureTransitionStatus): string {
  const failure = status.failure;
  if (!failure) return 'The change did not complete. Nothing was lost; you can try again.';
  switch (failure.kind) {
    case 'insufficient_disk':
      return `There is not enough free space to make the backup. Free up about ${failure.requiredMegabytes} MB (${failure.availableMegabytes} MB is available), then try again. Nothing has been changed.`;
    case 'backup_failed':
      return 'The backup could not be made or checked, so nothing was changed and your existing demo mailbox is intact. You can try again, or close this window.';
    case 'reset_failed':
      return 'The backup is safe, but the old files could not all be removed yet. Try again; nothing is lost and it will finish where it stopped.';
  }
}

export const UNAVAILABLE_MESSAGE = 'Could not check the demo mailbox storage. Close this window and try again.';

export interface FixtureTransitionGate {
  phase: Ref<GatePhase>;
  status: Ref<FixtureTransitionStatus | null>;
  /** True while the user must not be able to reach the app. */
  blocking: ComputedRef<boolean>;
  load(): Promise<void>;
  accept(): Promise<void>;
}

export function useFixtureTransition(client: MailClient): FixtureTransitionGate {
  const phase = ref<GatePhase>('checking');
  const status = ref<FixtureTransitionStatus | null>(null);
  let inFlight = false;

  function apply(next: FixtureTransitionStatus): void {
    status.value = next;
    switch (next.state) {
      case 'not_needed':
      case 'done':
        phase.value = 'clear';
        break;
      case 'needs_disclosure':
        phase.value = 'disclosure';
        break;
      case 'failed':
        phase.value = 'failed';
        break;
    }
  }

  async function load(): Promise<void> {
    phase.value = 'checking';
    try {
      apply(await client.getFixtureTransitionStatus());
    } catch {
      phase.value = 'unavailable';
    }
  }

  async function accept(): Promise<void> {
    // One attempt at a time; a double click never starts a second backup.
    if (inFlight || (phase.value !== 'disclosure' && phase.value !== 'failed')) return;
    inFlight = true;
    phase.value = 'working';
    try {
      apply(await client.acceptFixtureTransition());
    } catch {
      // The backend refused or crashed mid-way. It is crash safe: ask it again.
      await load();
    } finally {
      inFlight = false;
    }
  }

  return { phase, status, blocking: computed(() => phase.value !== 'clear'), load, accept };
}
