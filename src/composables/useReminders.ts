/**
 * Device-local reminders: the state and request semantics behind
 * the Reminders list context. The list, the header tabs and the in-flow picker
 * all read this one object; it lives in App so the selected tab, the loaded
 * rows and an open picker survive the reader round trip.
 *
 * Request semantics (unchanged from the drawer panel this replaces):
 * - Every list read is fenced by a generation token; a stale answer never lands.
 * - Every editor operation (prepare, put, cancel) is fenced by an editor token.
 *   Dismissing the picker, changing the target or leaving the context bumps it,
 *   so a late response can neither reopen a picker nor clear a newer one.
 * - A put or cancel that is not acknowledged keeps its exact payload as the
 *   retry; `Retry exact request` replays it byte for byte (same request id).
 *   A rejected `dueAt` is a validation error, never a replayable request.
 * - A source rejected as `sourceMessageId` on a new reminder (expectedRevision
 *   null) goes back to preparation for the same conversation, never to a new
 *   schedule.
 * - The time comes from the shared `ReminderPicker` (suggestions plus typed
 *   natural-language or RFC3339 time). The Schedule / Save button is armed only
 *   after the picker chose a time, and typing again disarms it, so a payload
 *   always carries a time the picker resolved.
 * - A put acknowledged by the transport reports to `onScheduled` (the app
 *   returns to the Inbox with a receipt line); dismissing the picker of a new
 *   reminder reports to `onDismissed`.
 */
import { computed, nextTick, onScopeDispose, ref, shallowRef } from 'vue';
import type { CancelReminder, ConversationRef, MailClient, PutReminder, Reminder, ReminderCondition, ReminderPhase } from '../lib/ipc/client';
import { toMailError } from '../lib/ipc/client';

export type ReminderDestination = 'pending' | 'returned' | 'history';
export const REMINDER_TABS: ReadonlyArray<{ id: ReminderDestination; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'returned', label: 'Returned' },
  { id: 'history', label: 'History' },
];
/** The standing limits of the feature: one visible phrase, the rest a title and hidden text. */
export const REMINDERS_NOTE_LINE = 'Saved on this device. Runs while Email OS is open; overdue reminders are checked at start.';
export const REMINDERS_NOTE_DETAIL = 'Reminders are saved on this device and run while Email OS is open. Overdue reminders are checked when Email OS starts. '
  + 'Scheduling hides this conversation from the Email OS Inbox. New incoming mail stays visible. Return and Cancel show only the original inbox messages again; neither marks mail read.';
export const REMINDER_PHASES: Record<ReminderPhase, { word: string; tone: 'warn' | 'fault' | 'calm' }> = {
  pending: { word: 'Waiting', tone: 'calm' },
  removing: { word: 'Hiding from Inbox', tone: 'warn' },
  returning: { word: 'Returning to Inbox', tone: 'warn' },
  returned: { word: 'In Inbox', tone: 'calm' },
  failed: { word: 'Needs attention', tone: 'fault' },
  cancelling: { word: 'Restoring Inbox', tone: 'warn' },
  cancelled: { word: 'Cancelled', tone: 'calm' },
  suppressed: { word: 'Skipped after reply', tone: 'calm' },
};

export interface ReminderSource { conversation: ConversationRef; sourceMessageId: string; revision: number | null; subject: string; sender: string | null }
/** Polite words for one row action: what to say when it resolves (from its result) and when it fails. */
interface ActionWords { done: (result: unknown) => string; failed: string }
interface RetryRequest { action: () => Promise<unknown>; command?: PutReminder; words?: ActionWords }
/** An acknowledged cancel can still be moving: say "Cancelling" until the row says it is cancelled. */
const CANCEL_WORDS: ActionWords = {
  done: result => ((result as Reminder | undefined)?.phase === 'cancelling' ? 'Cancelling reminder' : 'Reminder cancelled'),
  failed: 'Could not cancel reminder',
};
const RESCHEDULE_WORDS: ActionWords = { done: () => 'Reminder rescheduled', failed: 'Could not reschedule reminder' };

/**
 * Rows of the Pending tab that are not calm waiting: a failed reminder, and one
 * still moving (removing, returning, cancelling). They list first under
 * "Needs attention" and are not counted as Pending.
 */
export const NEEDS_ATTENTION_LABEL = 'Needs attention';
function needsAttention(r: Reminder): boolean {
  return bucketOf(r) === 'pending' && r.phase !== 'pending';
}

function bucketOf(r: Reminder): ReminderDestination {
  return r.phase === 'returned' ? 'returned' : r.phase === 'suppressed' || r.phase === 'cancelled' ? 'history' : 'pending';
}
function sameRef(a: ConversationRef | null, b: ConversationRef | null): boolean {
  return a === b || (!!a && !!b && a.accountId === b.accountId && a.conversationId === b.conversationId);
}

export interface RemindersOptions {
  initialDestination?: ReminderDestination;
  /** A put was acknowledged. `rescheduled` is true when it changed an existing reminder. */
  onScheduled?: (receipt: Reminder, rescheduled: boolean) => void;
  /** The user dismissed a picker for a new reminder (Remind me) without scheduling. */
  onDismissed?: () => void;
}

export function useReminders(client: MailClient, options: RemindersOptions = {}) {
  const rows = ref<Reminder[]>([]);
  const error = ref('');
  const preparationError = ref('');
  const preparationTarget = ref<ConversationRef | null>(null);
  const busy = ref(false);
  const loading = ref(true);
  /**
   * True once a list read has succeeded in this session. Until then the counts
   * are 0 because nothing was read, not because nothing exists: the header tabs,
   * the empty line and the `[` / `]` words must not say so.
   */
  const loadedOnce = ref(false);
  const source = ref<ReminderSource | null>(null);
  /** The time the picker resolved (RFC3339 with offset), or null for Someday. */
  const dueAt = ref<string | null>(null);
  /** True once the picker chose a time (or Someday); typing again clears it. */
  const pickerReady = ref(false);
  const condition = ref<ReminderCondition>('if_no_reply');
  const destination = ref<ReminderDestination>(options.initialDestination ?? 'pending');
  /** The conversation the picker was requested for (Remind me); null for the plain list. */
  const target = ref<ConversationRef | null>(null);
  /** The row key (conversation id) the list last had focus on; survives the reader round trip. */
  const activeRow = ref<string | null>(null);
  const retry = shallowRef<RetryRequest | null>(null);
  const retrying = computed(() => retry.value !== null);

  let live = false;
  let session = 0;
  let generation = 0;
  let editorGeneration = 0;
  let unsubscribe: (() => void) | undefined;
  let loaded: Promise<void> = Promise.resolve();

  /**
   * The rows of the selected tab. In Pending, rows that need attention come
   * first (failed before in-flight), then the calm pending rows; the order the
   * list gave is kept inside each part.
   */
  const displayed = computed(() => {
    const inTab = rows.value.filter(r => bucketOf(r) === destination.value);
    if (destination.value !== 'pending') return inTab;
    const rank = (r: Reminder) => (r.phase === 'pending' ? 2 : r.phase === 'failed' ? 0 : 1);
    return inTab.map((r, index) => ({ r, index })).sort((a, b) => rank(a.r) - rank(b.r) || a.index - b.index).map(({ r }) => r);
  });
  /** How many rows of the Pending tab need attention (the label's count). */
  const attentionCount = computed(() => (destination.value === 'pending' ? displayed.value.filter(needsAttention).length : 0));
  /**
   * How many loaded rows need attention, whichever tab is selected. The Pending
   * tab shows "· N needs attention" beside its count only when this is above 0.
   */
  const attentionTotal = computed(() => rows.value.filter(needsAttention).length);
  /**
   * Counts of the currently loaded rows per tab. Returned and History count their
   * rows; Pending counts only rows waiting calmly (phase `pending`), because the
   * rows that need attention are counted by their own label.
   */
  const counts = computed<Record<ReminderDestination, number>>(() => {
    const result: Record<ReminderDestination, number> = { pending: 0, returned: 0, history: 0 };
    for (const r of rows.value) if (!needsAttention(r)) result[bucketOf(r)]++;
    return result;
  });

  // ---- Tabs: their own arrow keys; rows use J/K/arrows (useDrawerRows) -------
  /** Polite words for the last list-side tab change (`[` / `]`); the list renders them in a live region. */
  const tabAnnouncement = ref('');
  /** Polite words for the last row action (Cancel reminder, Reschedule), said only after it resolved or failed. */
  const actionAnnouncement = ref('');
  function announceAction(words: string) {
    // Clear first so the same words announce again after a repeated action.
    actionAnnouncement.value = '';
    void nextTick(() => { if (live) actionAnnouncement.value = words; });
  }
  /**
   * Move to the previous or next tab with the same wrap as the tablist's arrow
   * keys, forget the old current row (the new tab starts at its first row) and
   * announce the new tab. The caller moves focus into the list.
   */
  function stepDestination(delta: 1 | -1) {
    const index = REMINDER_TABS.findIndex(tab => tab.id === destination.value);
    const next = REMINDER_TABS[(index + delta + REMINDER_TABS.length) % REMINDER_TABS.length]!;
    destination.value = next.id;
    activeRow.value = null;
    // The same numbers the tab shows. Attention rows are never "no reminders".
    // Before the first successful read there are no numbers: name the tab only.
    const count = counts.value[next.id];
    const attention = attentionCount.value;
    const calm = `${count} ${count === 1 ? 'reminder' : 'reminders'}`;
    const flagged = `${attention} ${attention === 1 ? 'needs' : 'need'} attention`;
    const words = !loadedOnce.value ? next.label
      : attention === 0
        ? `${next.label}, ${count === 0 ? 'no reminders' : calm}`
        : count === 0 ? `${next.label}, ${flagged}` : `${next.label}, ${calm}. ${NEEDS_ATTENTION_LABEL} ${attention}`;
    // Clear first so the same words announce again after an unrelated tab change.
    tabAnnouncement.value = '';
    void nextTick(() => { tabAnnouncement.value = words; });
  }
  function onTabKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const index = REMINDER_TABS.findIndex(tab => tab.id === destination.value);
    const last = REMINDER_TABS.length - 1;
    const next = event.key === 'ArrowRight' ? (index + 1) % REMINDER_TABS.length
      : event.key === 'ArrowLeft' ? (index + last) % REMINDER_TABS.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? last
            : null;
    if (next === null) return;
    event.preventDefault();
    destination.value = REMINDER_TABS[next]!.id;
    void nextTick(() => document.getElementById(`reminder-tab-${destination.value}`)?.focus());
  }

  async function refresh() {
    const token = ++generation;
    try {
      const result = await client.reminders!.list();
      if (live && token === generation) {
        rows.value = result; loadedOnce.value = true; loading.value = false;
        if (error.value === 'Could not load local reminders. Retry refresh.') error.value = '';
      }
    } catch { if (live && token === generation) { error.value = 'Could not load local reminders. Retry refresh.'; loading.value = false; } }
  }

  async function run(action: () => Promise<unknown>, command?: PutReminder, words?: ActionWords) {
    if (busy.value) return;
    const token = editorGeneration;
    // Retain both the exact payload and its validation context after a lost ACK.
    busy.value = true; error.value = ''; retry.value = { action, command, words };
    try {
      const result = await action() as Reminder;
      // The action resolved: say so, even if the picker was dismissed meanwhile.
      if (live && words) announceAction(words.done(result));
      if (live && token === editorGeneration) {
        retry.value = null;
        if (command) options.onScheduled?.(result, command.expectedRevision !== null);
        source.value = null; dueAt.value = null; pickerReady.value = false;
        await refresh();
      }
    }
    catch (raw) {
      if (live && words) announceAction(words.failed);
      if (live && token === editorGeneration) {
        const failure = toMailError(raw);
        if (failure.kind === 'invalid_request' && failure.field === 'dueAt') {
          retry.value = null;
          error.value = 'Choose a future time. The selected time must include Z or a numeric timezone offset.';
        } else if (failure.kind === 'invalid_request' && failure.field === 'sourceMessageId' && command?.expectedRevision === null) {
          retry.value = null; source.value = null;
          preparationTarget.value = { ...command.conversation };
          preparationError.value = 'This conversation has a newer message. Refresh the source, review it, then schedule again.';
        } else if (failure.kind === 'invalid_request' || failure.kind === 'not_found') {
          retry.value = null; source.value = null;
          error.value = 'This reminder is no longer actionable. Refresh and choose the current reminder before editing.';
          await refresh();
        } else {
          error.value = 'Reminder change was not acknowledged. Retry the exact request, or refresh to inspect saved state. Refresh before editing a stale reminder.';
        }
      }
    }
    finally { if (live && token === editorGeneration) busy.value = false; }
  }

  async function prepare(requestedTarget: ConversationRef) {
    if (busy.value || retry.value) return;
    const token = ++editorGeneration;
    const requested = { ...requestedTarget };
    preparationTarget.value = requested;
    source.value = null;
    busy.value = true;
    try {
      const conversation = await client.getConversation(requested);
      if (!live || token !== editorGeneration) return;
      const latest = conversation.messages.at(-1);
      if (conversation.ref.accountId !== requested.accountId || conversation.ref.conversationId !== requested.conversationId || !latest) {
        preparationError.value = 'No current source message is available for this conversation. Retry preparation after it is available.';
        return;
      }
      if (conversation.retainedSnapshotAt || conversation.contextComplete === false) {
        preparationError.value = 'This conversation is retained or incomplete. A current conversation is required; retry preparation after it is available.';
        return;
      }
      source.value = { conversation: requested, sourceMessageId: latest.id, revision: null, subject: conversation.subject, sender: latest.from.displayName?.trim() || latest.from.mailbox || null };
      preparationTarget.value = null;
      preparationError.value = '';
    } catch { if (live && token === editorGeneration) preparationError.value = 'Could not load the current source message. Retry preparation for this conversation.'; }
    finally { if (live && token === editorGeneration) busy.value = false; }
  }

  /** A new picker starts from a clean choice; recovery of the same picker keeps what was chosen. */
  function resetChoices() {
    dueAt.value = null; pickerReady.value = false; condition.value = 'if_no_reply';
  }

  function dismissPicker() {
    editorGeneration++;
    busy.value = false; retry.value = null; source.value = null; dueAt.value = null; pickerReady.value = false;
    preparationTarget.value = null; preparationError.value = '';
  }

  /** The picker cannot be dismissed while its request is in flight or waiting for an exact retry. */
  const dismissBlocked = computed(() => source.value !== null && (busy.value || retry.value !== null));

  /** The user closed the picker. Dismissing a new reminder's picker also ends the Remind me request. */
  function closePicker() {
    if (dismissBlocked.value) return;
    const wasNew = source.value?.revision === null;
    dismissPicker();
    if (wasNew) options.onDismissed?.();
  }

  /**
   * Ask for the picker for one conversation (`Remind me`), or clear the request.
   * A changed target dismisses whatever editor is open and prepares the new one;
   * the same target again changes nothing.
   */
  function setTarget(next: ConversationRef | null) {
    const changed = !sameRef(target.value, next);
    target.value = next ? { ...next } : null;
    if (next) destination.value = 'pending';
    if (!live || !changed) return;
    dismissPicker();
    resetChoices();
    if (next) void prepare(next);
  }

  function reschedule(r: Reminder) {
    dismissPicker(); error.value = '';
    source.value = { conversation: r.conversation, sourceMessageId: r.sourceMessageId, revision: r.revision, subject: r.subject, sender: null };
    dueAt.value = r.dueAt;
    // A saved time in the past must be replaced before Save arms; Someday and future times are ready.
    pickerReady.value = r.dueAt === null || (Number.isFinite(Date.parse(r.dueAt)) && Date.parse(r.dueAt) > Date.now());
    condition.value = r.condition;
  }

  function selectTime(value: string | null) { dueAt.value = value; pickerReady.value = true; }
  function editTime() { pickerReady.value = false; }

  function submit() {
    if (!source.value || !pickerReady.value || retry.value || busy.value) return;
    const command: PutReminder = { conversation: source.value.conversation, sourceMessageId: source.value.sourceMessageId, expectedRevision: source.value.revision, dueAt: dueAt.value, condition: condition.value, requestId: crypto.randomUUID() };
    void run(() => client.reminders!.put(command), command, command.expectedRevision === null ? undefined : RESCHEDULE_WORDS);
  }
  function cancel(r: Reminder) {
    const command: CancelReminder = { conversation: r.conversation, expectedRevision: r.revision, requestId: crypto.randomUUID() };
    void run(() => client.reminders!.cancel(command), undefined, CANCEL_WORDS);
  }
  /** The toolbar's primary button: replay the exact lost request, else refresh. */
  function retryOrRefresh() {
    const pending = retry.value;
    if (pending) void run(pending.action, pending.command, pending.words);
    else void refresh();
  }
  function inspectSavedState() {
    if (busy.value) return;
    dismissPicker(); error.value = '';
    void refresh();
  }

  /**
   * Start a session: subscribe to live changes, load the rows, then prepare the
   * requested picker. Idempotent while live; the returned promise settles after
   * the first load (and preparation) of this session.
   */
  function activate(): Promise<void> {
    if (live) return loaded;
    live = true;
    const mine = ++session;
    rows.value = []; loading.value = true; loadedOnce.value = false; error.value = ''; actionAnnouncement.value = '';
    dismissPicker();
    resetChoices();
    const isMine = () => live && session === mine;
    loaded = (async () => {
      const token = editorGeneration;
      try {
        const stop = await client.subscribe(() => { void refresh(); });
        if (!isMine()) { stop(); return; }
        unsubscribe = stop;
      } catch { if (isMine()) error.value = 'Live updates unavailable. Refresh to inspect progress.'; }
      await refresh();
      if (isMine() && token === editorGeneration && target.value) await prepare(target.value);
    })();
    return loaded;
  }

  /** End the session: late answers are dropped, the picker closes, the tab is kept. */
  function deactivate() {
    if (!live) return;
    live = false; session++; generation++;
    unsubscribe?.(); unsubscribe = undefined;
    dismissPicker();
    target.value = null;
    tabAnnouncement.value = ''; actionAnnouncement.value = '';
  }
  onScopeDispose(deactivate);

  return {
    rows, error, preparationError, preparationTarget, busy, loading, source, dueAt, pickerReady, condition,
    destination, target, activeRow, retrying, dismissBlocked, tabAnnouncement, actionAnnouncement, loadedOnce,
    displayed, attentionCount, attentionTotal, counts,
    onTabKeydown, stepDestination, refresh, prepare, dismissPicker, closePicker, setTarget, reschedule, selectTime, editTime, submit, cancel, retryOrRefresh, inspectSavedState,
    activate, deactivate, whenLoaded: () => loaded,
  };
}

export type RemindersModel = ReturnType<typeof useReminders>;
