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

/**
 * Wording for a failed Discard from the Drafts list. No editor is open there,
 * so nothing says "your text remains in the editor"; the draft stays in the list.
 */
export function describeDiscardError(error: MailError): string {
  switch (error.kind) {
    case 'draft_conflict': return `Draft not discarded: it changed to revision ${error.currentRevision}. Open it to review.`;
    case 'not_found': return 'Draft not discarded: that local draft is no longer available.';
    case 'auth_required': return 'Draft not discarded: no active account. Reconnect the same account to manage its local drafts.';
    case 'profile_in_use': return 'Draft not discarded: the local profile is in use by another window. Retry is safe.';
    case 'busy': return 'Draft not discarded: it is open in an editor. Close the editor first.';
    case 'storage_unavailable': return 'Draft not discarded: local storage did not confirm the delete. Retry is safe.';
    default: return 'Draft not discarded: the local delete was not confirmed. Retry is safe.';
  }
}

/** A rejection that cannot succeed on retry: the confirmation closes and the draft stays as it is. */
export function isDefiniteDiscardFailure(error: MailError): boolean {
  return ['draft_conflict', 'not_found', 'invalid_request', 'request_id_conflict', 'auth_required', 'busy'].includes(error.kind);
}
