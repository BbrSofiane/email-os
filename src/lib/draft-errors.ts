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
