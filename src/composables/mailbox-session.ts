/**
 * The explicit session/generation dependency handed to extracted mailbox
 * composables. `useMailbox` owns the counters; a piece receives this read-only
 * view and compares `generation` captured at call time against the live value
 * after every await, so a response that outlives an account change, disconnect
 * or reconnect is dropped. Nothing here is module-level state.
 */
export interface MailboxSession {
  /** Bumped on account identity change and on disconnect. */
  readonly generation: number;
  /** True once the owning scope is disposed; no result may publish afterwards. */
  readonly detached: boolean;
}

/** The shared single-owner command fence (single and group mutations bump one counter). */
export interface CommandFence {
  /** Claims the next command token, superseding every earlier owner. */
  next(): number;
  current(): number;
}
