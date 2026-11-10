import type { MailError } from './ipc/client';

/**
 * Single shared copy of the user-facing draft/mail error wording, used by the
 * Drafts list (DraftAlerts) and the composer body (DraftEditorCore). Do not
 * fork per component.
 */
export function describeDraftError(error: MailError): string {
  switch (error.kind) {
    case 'draft_conflict': return `Conflict: another save created revision ${error.currentRevision}. Your text is unchanged.`;
    case 'invalid_request': return `Invalid ${error.field}; correct the text and retry.`;
    case 'reply_unavailable': return 'Reply preparation is unavailable: current complete reply headers could not be verified.';
    case 'not_found': return 'That local draft is no longer available.';
    case 'auth_required': return 'No active account. Reconnect the same account to access its local drafts.';
    case 'profile_in_use': return 'The local profile is in use by another window.';
    case 'request_id_conflict': return 'The request ID conflicted; your text remains in the editor.';
    case 'storage_unavailable': return 'Local storage did not confirm the save. Retry is safe.';
    default: return 'The local draft operation was not confirmed. Your text remains in the editor.';
  }
}

/** Why the list refused a Discard with `busy`; the list knows it, the error itself does not. */
export type DiscardBusyReason = 'editor' | 'opening' | 'switching' | 'closing_window';

const BUSY_TEXT: Record<DiscardBusyReason, string> = {
  editor: 'Draft not discarded: it is open in an editor. Close the editor first.',
  opening: 'Draft not discarded: it is being opened. Close the editor once it has opened.',
  switching: 'Draft not discarded: the editor is switching drafts. Try again in a moment.',
  closing_window: 'Draft not discarded: the window is closing.',
};

type DiscardEntry<K extends MailError['kind']> = {
  /** A rejection that cannot succeed on retry: the confirmation closes and the draft stays as it is. */
  definite: boolean;
  text: (error: Extract<MailError, { kind: K }>, busy: DiscardBusyReason) => string;
};

const RETRY = { definite: false, text: () => 'Draft not discarded: the local delete was not confirmed. Retry is safe.' };

/**
 * One row per error kind: whether the failure is definite and what a failed
 * Discard from the Drafts list says. No editor is open there, so nothing says
 * "your text remains in the editor"; the draft stays in the list. Exhaustive
 * by type: a new `MailError` kind does not compile until it is classified.
 */
const DISCARD_ERRORS: { [K in MailError['kind']]: DiscardEntry<K> } = {
  draft_conflict: { definite: true, text: (e) => `Draft not discarded: it changed to revision ${e.currentRevision}. Open it to review.` },
  not_found: { definite: true, text: () => 'Draft not discarded: that local draft is no longer available.' },
  invalid_request: { definite: true, text: () => 'Draft not discarded: the delete request was invalid.' },
  request_id_conflict: { definite: true, text: () => 'Draft not discarded: the delete request conflicted with an earlier one. Discard again to retry.' },
  auth_required: { definite: true, text: () => 'Draft not discarded: no active account. Reconnect the same account to manage its local drafts.' },
  busy: { definite: true, text: (_e, busy) => BUSY_TEXT[busy] },
  profile_in_use: { definite: false, text: () => 'Draft not discarded: the local profile is in use by another window. Retry is safe.' },
  storage_unavailable: { definite: false, text: () => 'Draft not discarded: local storage did not confirm the delete. Retry is safe.' },
  read_only: RETRY,
  not_configured: RETRY,
  auth_cancelled: RETRY,
  auth_failed: RETRY,
  secrets_unavailable: RETRY,
  network_unavailable: RETRY,
  rate_limited: RETRY,
  provider_unavailable: RETRY,
  invalid_provider_response: RETRY,
  permission_required: RETRY,
  provider_rejected: RETRY,
  outcome_unknown: RETRY,
  reply_unavailable: RETRY,
  undo_unavailable: RETRY,
};

type AnyDiscardEntry = { definite: boolean; text: (error: MailError, busy: DiscardBusyReason) => string };
const entryFor = (error: MailError) => DISCARD_ERRORS[error.kind] as AnyDiscardEntry;

/** Wording for a failed Discard from the Drafts list. `busy` is the reason the list refused it. */
export function describeDiscardError(error: MailError, busy: DiscardBusyReason = 'editor'): string {
  return entryFor(error).text(error, busy);
}

/** A rejection that cannot succeed on retry: the confirmation closes and the draft stays as it is. */
export function isDefiniteDiscardFailure(error: MailError): boolean {
  return entryFor(error).definite;
}
