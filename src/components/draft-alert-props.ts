import type { MailError } from '../lib/ipc/client';

/** The recovery and error state `DraftAlerts` shows; `DraftsList` passes the same fields through. */
export interface DraftAlertProps {
  suspendedEditor?: boolean;
  closeError?: string | null;
  closeSetupError?: string | null;
  closeRetryAvailable?: boolean;
  listError: MailError | null;
  subscriptionError: MailError | null;
  /** An unopenable or uncreatable draft (opening it failed). */
  createError?: MailError | null;
}
