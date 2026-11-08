/**
 * Desktop-local reminders (fixture only): the state and request semantics behind
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
 * - Presets only fill the same `due` value the typed field fills, so payloads,
 *   request ids and revisions are exactly the typed path.
 */
import { computed, nextTick, onScopeDispose, ref, shallowRef } from 'vue';
import type { CancelReminder, ConversationRef, MailClient, PutReminder, Reminder, ReminderCondition, ReminderPhase } from '../lib/ipc/client';
import { toMailError } from '../lib/ipc/client';
import { reminderPresets, type ReminderPresets } from '../lib/reminder-presets';

export type ReminderDestination = 'pending' | 'returned' | 'history';
export const REMINDER_TABS: ReadonlyArray<{ id: ReminderDestination; label: string }> = [
  { id: 'pending', label: 'Pending' },
  { id: 'returned', label: 'Returned' },
  { id: 'history', label: 'History' },
];
/** The standing limits of the fixture feature: one visible phrase, the rest a title. */
export const REMINDERS_FIXTURE_LINE = 'Synthetic fixture only';
export const REMINDERS_FIXTURE_DETAIL = 'This device, while running. Overdue work reconciles on launch. No execution while fully quit or on other devices. '
  + 'New incoming mail stays in Inbox. Return and Cancel restore only the original inbox messages; neither marks mail read.';
export const REMINDER_PHASES: Record<ReminderPhase, { word: string; tone: 'warn' | 'fault' | 'calm' }> = {
  pending: { word: 'Pending', tone: 'calm' },
  removing: { word: 'Removing…', tone: 'warn' },
  returning: { word: 'Returning…', tone: 'warn' },
  returned: { word: 'Returned', tone: 'calm' },
  failed: { word: 'Failed', tone: 'fault' },
  cancelling: { word: 'Cancelling…', tone: 'warn' },
  cancelled: { word: 'Cancelled', tone: 'calm' },
  suppressed: { word: 'Suppressed', tone: 'calm' },
};

export interface ReminderSource { conversation: ConversationRef; sourceMessageId: string; revision: number | null; subject: string }
interface RetryRequest { action: () => Promise<unknown>; command?: PutReminder }

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
  const source = ref<ReminderSource | null>(null);
  const due = ref('');
  /** Preset times, computed when the picker opens (one stable set per open picker). */
  const presets = ref<ReminderPresets>(reminderPresets(new Date()));
  const customOpen = ref(false);
  const someday = ref(false);
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
    const count = counts.value[next.id];
    const attention = attentionCount.value;
    const calm = `${count} ${count === 1 ? 'reminder' : 'reminders'}`;
    const flagged = `${attention} ${attention === 1 ? 'needs' : 'need'} attention`;
    const words = attention === 0
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
      if (live && token === generation) { rows.value = result; loading.value = false; }
    } catch { if (live && token === generation) { error.value = 'Could not load local reminders. Retry refresh.'; loading.value = false; } }
  }

  async function run(action: () => Promise<unknown>, command?: PutReminder) {
    if (busy.value) return;
    const token = editorGeneration;
    // Retain both the exact payload and its validation context after a lost ACK.
    busy.value = true; error.value = ''; retry.value = { action, command };
    try {
      const result = await action() as Reminder;
      if (live && token === editorGeneration) {
        retry.value = null;
        if (command) options.onScheduled?.(result, command.expectedRevision !== null);
        source.value = null;
        await refresh();
      }
    }
    catch (raw) {
      if (live && token === editorGeneration) {
        const failure = toMailError(raw);
        if (failure.kind === 'invalid_request' && failure.field === 'dueAt') {
          retry.value = null;
          error.value = 'Choose a future RFC3339 time with seconds and Z or a numeric timezone offset. Local times and leap seconds are not supported.';
        } else if (failure.kind === 'invalid_request' && failure.field === 'sourceMessageId' && command?.expectedRevision === null) {
          retry.value = null; source.value = null;
          preparationTarget.value = { ...command.conversation };
          preparationError.value = 'This conversation has a newer message. Refresh the source, review it, then schedule again.';
        } else if (failure.kind === 'invalid_request' || failure.kind === 'not_found') {
          retry.value = null; source.value = null;
          error.value = 'This target or revision is no longer actionable. Refresh and choose the current reminder before editing.';
          await refresh();
        } else {
          error.value = 'Reminder change was not acknowledged. Retry the exact request, or refresh to inspect durable state. Stale revisions require refresh before editing.';
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
      source.value = { conversation: requested, sourceMessageId: latest.id, revision: null, subject: conversation.subject };
      presets.value = reminderPresets(new Date());
      preparationTarget.value = null;
      preparationError.value = '';
    } catch { if (live && token === editorGeneration) preparationError.value = 'Could not load the current source message. Retry preparation for this conversation.'; }
    finally { if (live && token === editorGeneration) busy.value = false; }
  }

  /** A new picker starts from a clean choice; recovery of the same picker keeps what was chosen. */
  function resetChoices() {
    due.value = ''; someday.value = false; condition.value = 'if_no_reply'; customOpen.value = false;
  }

  function dismissPicker() {
    editorGeneration++;
    busy.value = false; retry.value = null; source.value = null;
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
    source.value = { conversation: r.conversation, sourceMessageId: r.sourceMessageId, revision: r.revision, subject: r.subject };
    presets.value = reminderPresets(new Date());
    due.value = r.dueAt ?? ''; someday.value = r.dueAt === null; condition.value = r.condition;
    customOpen.value = false;
  }

  const presetList = computed(() => {
    const list: Array<{ id: string; label: string; at: string }> = [];
    if (presets.value.laterToday) list.push({ id: 'later', label: 'Later today', at: presets.value.laterToday });
    list.push({ id: 'tomorrow', label: 'Tomorrow', at: presets.value.tomorrow });
    list.push({ id: 'next-week', label: 'Next week', at: presets.value.nextWeek });
    return list;
  });
  /** A typed or saved time that is not a preset is never hidden: Custom opens by itself. */
  const customForced = computed(() => !someday.value && due.value !== '' && !presetList.value.some(preset => preset.at === due.value));
  const customShown = computed(() => customOpen.value || customForced.value);
  function choosePreset(at: string) { due.value = at; someday.value = false; customOpen.value = false; }

  function submit() {
    if (!source.value || retry.value) return;
    if (!someday.value && due.value.trim() === '') return;
    const command: PutReminder = { conversation: source.value.conversation, sourceMessageId: source.value.sourceMessageId, expectedRevision: source.value.revision, dueAt: someday.value ? null : due.value, condition: condition.value, requestId: crypto.randomUUID() };
    void run(() => client.reminders!.put(command), command);
  }
  function cancel(r: Reminder) {
    const command: CancelReminder = { conversation: r.conversation, expectedRevision: r.revision, requestId: crypto.randomUUID() };
    void run(() => client.reminders!.cancel(command));
  }
  /** The toolbar's primary button: replay the exact lost request, else refresh. */
  function retryOrRefresh() {
    const pending = retry.value;
    if (pending) void run(pending.action, pending.command);
    else void refresh();
  }
  function inspectDurableState() {
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
    rows.value = []; loading.value = true; error.value = '';
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
    tabAnnouncement.value = '';
  }
  onScopeDispose(deactivate);

  return {
    rows, error, preparationError, preparationTarget, busy, loading, source, due, presets, customOpen, someday, condition,
    destination, target, activeRow, retrying, dismissBlocked, tabAnnouncement,
    displayed, attentionCount, attentionTotal, counts, presetList, customForced, customShown,
    onTabKeydown, stepDestination, refresh, prepare, dismissPicker, closePicker, setTarget, reschedule, choosePreset, submit, cancel, retryOrRefresh, inspectDurableState,
    activate, deactivate, whenLoaded: () => loaded,
  };
}

export type RemindersModel = ReturnType<typeof useReminders>;
