export function errorText(error: { kind: string; field?: string; reason?: string }): string {
  switch (error.kind) {
    case 'not_found':
      return 'not found';
    case 'invalid_request':
      // No trailing period here: the banner templates append one themselves.
      if (error.field === 'searchQuery') return 'unsupported search syntax. Use text, straight-quoted phrases, from:, to:, subject:, AND, OR and -exclusions';
      if (error.field === 'cachedDoneRestoreRange') return 'cached Done changed beyond the restoration limit; retry or return to Inbox';
      return `invalid request (field: ${error.field ?? '?'})`;
    case 'request_id_conflict':
      return 'request ID conflict';
    case 'storage_unavailable':
      return 'storage unavailable';
    case 'profile_in_use':
      return 'profile in use';
    case 'read_only':
      return 'read-only account';
    case 'not_configured':
      return 'not configured';
    case 'auth_required':
      return 'sign-in required';
    case 'auth_cancelled':
      return 'sign-in cancelled';
    case 'auth_failed':
      return 'sign-in failed';
    case 'secrets_unavailable':
      return 'credential storage unavailable';
    case 'network_unavailable':
      return 'network unavailable';
    case 'rate_limited':
      return 'rate limited';
    case 'provider_unavailable':
      return 'provider unavailable';
    case 'invalid_provider_response':
      return 'unexpected provider response';
    case 'busy':
      return 'busy';
    case 'permission_required':
      return 'Google permission required';
    case 'provider_rejected':
      return 'provider rejected action';
    case 'outcome_unknown':
      return 'provider outcome unknown';
    case 'undo_unavailable':
      switch (error.reason) {
        case 'expired': return 'undo window expired';
        case 'superseded': return 'superseded by a newer action';
        case 'already_undone': return 'already undone';
        case 'not_applicable': return 'not undoable';
        case 'uncertain': return 'outcome unknown; use Activity';
        case 'unknown_prior': return 'prior state unknown';
        default: return 'undo unavailable';
      }
    default:
      return 'unknown error';
  }
}
