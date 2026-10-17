import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue';
import type { ClientMode } from '../lib/ipc';
import type {
  AppCloseRequest,
  CreateDraft,
  DeleteDraft,
  Draft,
  DraftContent,
  DraftRef,
  DraftReceipt,
  DraftSource,
  DraftSummary,
  MailClient,
  MailError,
  SaveDraft,
} from '../lib/ipc/client';

const EMPTY_CONTENT: DraftContent = { to: '', cc: '', subject: '', bodyText: '' };
const DEBOUNCE_MS = 300;

function copyContent(content: DraftContent): DraftContent {
  return { to: content.to, cc: content.cc, subject: content.subject, bodyText: content.bodyText };
}

function sameContent(left: DraftContent, right: DraftContent): boolean {
  return left.to === right.to && left.cc === right.cc && left.subject === right.subject && left.bodyText === right.bodyText;
}

function requestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: MailError): string {
  switch (error.kind) {
    case 'draft_conflict': return `This draft changed elsewhere (saved revision ${error.currentRevision}). Your exact text is preserved.`;
    case 'invalid_request': return `The local draft was not saved (invalid ${error.field}). Correct the field and save again.`;
    case 'reply_unavailable': return 'Reply preparation is unavailable because complete, current message headers could not be verified. No draft was created.';
    case 'not_found': return 'This draft is no longer available in the current account.';
    case 'auth_required': return 'The account is unavailable. Local drafts remain on this device and can be reopened after reconnecting the same account.';
    case 'profile_in_use': return 'The local profile is in use by another window. The text remains in this editor.';
    case 'request_id_conflict': return 'The save request conflicted with an earlier request. The text remains in this editor.';
    case 'storage_unavailable': return 'Local storage did not confirm this save. The text remains in this editor; retry safely.';
    default: return 'The local draft operation was not confirmed. The text remains in this editor.';
  }
}

export function useDrafts(client: MailClient, accountId: ComputedRef<string | null>, mode: ClientMode) {
  const summaries = ref<DraftSummary[]>([]);
  const listError = ref<MailError | null>(null);
  const draftSubscriptionError = ref<MailError | null>(null);
  const activeRef = ref<DraftRef | null>(null);
  const activeSource = ref<DraftSource | null>(null);
  const content = ref<DraftContent>(copyContent(EMPTY_CONTENT));
  const revision = ref(0);
  const acknowledged = ref<DraftContent>(copyContent(EMPTY_CONTENT));
  const hasReceipt = ref(false);
  const creating = ref(false);
  const saving = ref(false);
  const conflict = ref(false);
  const error = ref<MailError | null>(null);
  const createError = ref<MailError | null>(null);
  const deleting = ref(false);
  const closingForWindow = ref(false);
  const closeError = ref<string | null>(null);
  const closeRetryAvailable = ref(false);
  const confirmDiscard = ref(false);
  const discardBusy = ref(false);
  const confirmReload = ref(false);
  const copyPending = ref(false);
  const recoveryRequired = ref(false);
  const copyRetryEnvelope = ref<CreateDraft | null>(null);
  const transitioning = ref(false);
  const closeSetupError = ref<string | null>(null);
  const deletePending = ref(false);
  const isVisible = computed(() => !!activeRef.value && activeRef.value.accountId === accountId.value);
  const dirty = computed(() => !!activeRef.value && !sameContent(content.value, acknowledged.value));
  const canCancelReplyPreparation = computed(() => !!activeRef.value && !activeRef.value.draftId
    && activeSource.value?.kind === 'reply' && !hasReceipt.value && !dirty.value
    && !saving.value && !deleting.value && !copyPending.value);
  const hasUnsavedWork = computed(() => creating.value || saving.value || deleting.value || deletePending.value || copyPending.value || !!copyRetryEnvelope.value || recoveryRequired.value || dirty.value || !!retryEnvelope || !!createEnvelope);
  const statusLabel = computed(() => {
    if (conflict.value) return 'Conflict — edits preserved';
    if (error.value || createError.value) return 'Save not confirmed';
    if (creating.value) return 'Creating local draft…';
    if (saving.value || dirty.value || retryEnvelope || createEnvelope) return 'Saving locally…';
    if (!activeRef.value) return '';
    if (!hasReceipt.value) return mode === 'browser-preview' ? 'Loaded from preview memory (non-durable)' : 'Draft loaded from this device';
    return mode === 'browser-preview' ? 'Saved in preview memory (non-durable)' : 'Saved locally';
  });

  let listToken = 0;
  let generation = 0;
  let saveLaneGeneration = 0;
  let reloadAttempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeDrafts: (() => void) | null = null;
  let unsubscribeClose: (() => void) | null = null;
  let detached = false;
  let listSubscriptionAttempt: Promise<void> | null = null;
  let closeSubscriptionAttempt: Promise<void> | null = null;
  let inFlight: Promise<boolean> | null = null;
  let flushPromise: Promise<boolean> | null = null;
  let flushOwner: { generation: number; lane: number } | null = null;
  let retryEnvelope: SaveDraft | null = null;
  let createEnvelope: CreateDraft | null = null;
  let copyRetryOwner: { generation: number; accountId: string; draftId: string } | null = null;
  let copyPromise: Promise<boolean> | null = null;
  let deleteRetryEnvelope: DeleteDraft | null = null;
  let deletePromise: Promise<boolean> | null = null;
  let discardIntentToken = 0;
  let discardIntent: { token: number; generation: number; ref: DraftRef } | null = null;
  let createPromise: Promise<boolean> | null = null;
  let lastCloseRequestId: string | null = null;
  let closeToken = 0;
  let completionDispatched = false;

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function retireSaveLane(): void {
    saveLaneGeneration += 1;
    clearTimer();
    inFlight = null;
    saving.value = false;
    retryEnvelope = null;
  }

  function clearEditor(): void {
    generation += 1;
    saveLaneGeneration += 1;
    reloadAttempt += 1;
    clearTimer();
    activeRef.value = null;
    activeSource.value = null;
    content.value = copyContent(EMPTY_CONTENT);
    acknowledged.value = copyContent(EMPTY_CONTENT);
    revision.value = 0;
    hasReceipt.value = false;
    creating.value = false;
    saving.value = false;
    conflict.value = false;
    error.value = null;
    createError.value = null;
    deleting.value = false;
    confirmDiscard.value = false;
    discardBusy.value = false;
    discardIntentToken += 1;
    discardIntent = null;
    confirmReload.value = false;
    recoveryRequired.value = false;
    retryEnvelope = null;
    createEnvelope = null;
    copyRetryEnvelope.value = null;
    copyRetryOwner = null;
    copyPending.value = false;
    copyPromise = null;
    flushPromise = null;
    flushOwner = null;
    deleteRetryEnvelope = null;
    deletePending.value = false;
    deletePromise = null;
    createPromise = null;
    inFlight = null;
  }

  async function refresh(): Promise<void> {
    const targetAccount = accountId.value;
    const token = ++listToken;
    if (!targetAccount) {
      summaries.value = [];
      listError.value = null;
      return;
    }
    try {
      const rows = await client.listDrafts();
      if (detached || token !== listToken || targetAccount !== accountId.value) return;
      summaries.value = rows.filter((summary) => summary.ref.accountId === targetAccount);
      listError.value = null;
    } catch (raw) {
      if (detached || token !== listToken || targetAccount !== accountId.value) return;
      listError.value = normalizeError(raw);
    }
  }

  function normalizeError(raw: unknown): MailError {
    if (typeof raw === 'object' && raw !== null && 'kind' in raw) return raw as MailError;
    return { kind: 'storage_unavailable' };
  }

  async function ensureDraftSubscription(): Promise<void> {
    if (unsubscribeDrafts || detached) return;
    if (!listSubscriptionAttempt) {
      listSubscriptionAttempt = client.subscribeDrafts(() => { void refresh(); })
        .then((unlisten) => {
          if (detached) unlisten();
          else {
            unsubscribeDrafts = unlisten;
            draftSubscriptionError.value = null;
          }
        })
        .catch((raw) => {
          draftSubscriptionError.value = normalizeError(raw);
          throw raw;
        })
        .finally(() => { listSubscriptionAttempt = null; });
    }
    await listSubscriptionAttempt;
  }

  async function sendCreate(command: CreateDraft): Promise<boolean> {
    const token = generation;
    const expectedAccountId = activeRef.value?.accountId ?? null;
    if (!expectedAccountId || expectedAccountId !== accountId.value) {
      createError.value = { kind: 'auth_required' };
      creating.value = false;
      return false;
    }
    createEnvelope = command;
    createError.value = null;
    creating.value = true;
    const operation = (async () => {
      let receiptReceived = false;
      try {
        const receipt = await client.createDraft(command);
        receiptReceived = true;
        if (token !== generation || !activeRef.value) return false;
        if (accountId.value !== expectedAccountId || receipt.ref.accountId !== expectedAccountId) {
          createError.value = { kind: 'auth_required' };
          creating.value = false;
          return false;
        }
        const createdRef = receipt.ref;
        activeRef.value = createdRef;
        revision.value = receipt.revision;
        hasReceipt.value = true;
        const saved = await client.getDraft(createdRef);
        if (token !== generation || activeRef.value?.draftId !== createdRef.draftId || activeRef.value.accountId !== createdRef.accountId) return false;
        const beforeLoad = copyContent(content.value);
        const initialContent = command.initialContent ?? EMPTY_CONTENT;
        const hasLocalEdits = !sameContent(beforeLoad, initialContent);
        acknowledged.value = copyContent(initialContent);
        activeSource.value = saved.source;
        createEnvelope = null;
        createError.value = null;
        creating.value = false;
        if (hasLocalEdits && saved.revision !== receipt.revision) {
          revision.value = receipt.revision;
          conflict.value = true;
          error.value = { kind: 'draft_conflict', currentRevision: saved.revision };
          void refresh();
          return false;
        }
        if (!hasLocalEdits) {
          content.value = copyContent(saved.content);
          acknowledged.value = copyContent(saved.content);
        }
        revision.value = saved.revision;
        void refresh();
        if (!sameContent(content.value, acknowledged.value)) scheduleSave();
        return true;
      } catch (raw) {
        if (token !== generation) return false;
        const mailError = normalizeError(raw);
        if (receiptReceived && mailError.kind === 'not_found') {
          // The create is committed, but its ref disappeared before it could be
          // loaded. Keep the editable buffer and expose the normal recovery path;
          // replaying the create receipt can never restore a deleted draft.
          createEnvelope = null;
          creating.value = false;
          createError.value = null;
          error.value = mailError;
          return false;
        }
        createError.value = mailError;
        creating.value = receiptReceived && command.source.kind === 'reply';
        if (!receiptReceived && (mailError.kind === 'invalid_request' || mailError.kind === 'reply_unavailable' || mailError.kind === 'not_found')) createEnvelope = null;
        else createEnvelope = command;
        return false;
      }
    })();
    createPromise = operation;
    const succeeded = await operation;
    if (createPromise === operation) createPromise = null;
    return succeeded;
  }

  function scheduleSave(): void {
    clearTimer();
    if (!activeRef.value || creating.value || conflict.value || deleting.value || recoveryRequired.value || !dirty.value) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, DEBOUNCE_MS);
  }

  async function sendSave(command: SaveDraft, token: number): Promise<boolean> {
    const laneToken = saveLaneGeneration;
    const ownsSave = () => token === generation && laneToken === saveLaneGeneration && !!activeRef.value
      && activeRef.value.accountId === command.ref.accountId && activeRef.value.draftId === command.ref.draftId
      && accountId.value === command.ref.accountId;
    saving.value = true;
    error.value = null;
    // Keep the exact request recoverable until both its receipt and live ref are verified.
    retryEnvelope = command;
    const operation = (async () => {
      let receiptReceived = false;
      try {
        const receipt = await client.saveDraft(command);
        receiptReceived = true;
        if (!ownsSave()) return false;
        if (receipt.ref.accountId !== command.ref.accountId || receipt.ref.draftId !== command.ref.draftId) {
          conflict.value = true;
          error.value = { kind: 'draft_conflict', currentRevision: receipt.revision };
          retryEnvelope = null;
          return false;
        }

        // A deduplicated request may return its original receipt after a later save
        // or deletion. Only the matching live revision/content acknowledges this buffer.
        const liveDraft = await client.getDraft(command.ref);
        if (!ownsSave()) return false;
        if (liveDraft.ref.accountId !== command.ref.accountId || liveDraft.ref.draftId !== command.ref.draftId
          || liveDraft.revision !== receipt.revision || !sameContent(liveDraft.content, command.content)) {
          conflict.value = true;
          error.value = { kind: 'draft_conflict', currentRevision: liveDraft.revision };
          retryEnvelope = null;
          void refresh();
          return false;
        }

        revision.value = liveDraft.revision;
        acknowledged.value = copyContent(command.content);
        hasReceipt.value = true;
        retryEnvelope = null;
        recoveryRequired.value = false;
        error.value = null;
        void refresh();
        return true;
      } catch (raw) {
        if (!ownsSave()) return false;
        const mailError = normalizeError(raw);
        error.value = mailError;
        if (mailError.kind === 'draft_conflict') {
          conflict.value = true;
          retryEnvelope = null;
        } else if (mailError.kind === 'invalid_request') {
          // A validation failure is definite; a corrected buffer gets a new request ID/payload.
          retryEnvelope = null;
        } else if (mailError.kind === 'not_found' && receiptReceived) {
          // A historical receipt cannot recreate a deleted ref. Keep the exact buffer
          // available for an explicit independent copy instead.
          retryEnvelope = null;
          recoveryRequired.value = true;
          conflict.value = false;
          void refresh();
        }
        return false;
      } finally {
        if (token === generation && laneToken === saveLaneGeneration
          && activeRef.value?.accountId === command.ref.accountId
          && activeRef.value.draftId === command.ref.draftId) saving.value = false;
      }
    })();
    inFlight = operation;
    const result = await operation;
    if (inFlight === operation) inFlight = null;
    return result;
  }

  async function flush(): Promise<boolean> {
    const owner = { generation, lane: saveLaneGeneration };
    if (flushPromise && flushOwner?.generation === owner.generation && flushOwner.lane === owner.lane) return flushPromise;
    const operation = flushWork();
    flushPromise = operation;
    flushOwner = owner;
    try {
      return await operation;
    } finally {
      if (flushPromise === operation) {
        flushPromise = null;
        flushOwner = null;
      }
    }
  }

  async function flushWork(): Promise<boolean> {
    clearTimer();
    let token = generation;
    if (deletePromise) return deletePromise;
    if (deleteRetryEnvelope) return sendDelete(deleteRetryEnvelope);
    if (!activeRef.value) return true;
    if (activeRef.value.accountId !== accountId.value && (dirty.value || creating.value || saving.value || copyPending.value
      || !!copyRetryEnvelope.value || !!retryEnvelope || !!createEnvelope)) return false;

    // A recovery copy is an accepted save intent even while its create ACK is
    // pending or ambiguous. Reconcile that exact request before changing editors
    // or treating an unchanged original buffer as clean.
    if (copyPending.value || copyRetryEnvelope.value || copyPromise) {
      if (!(await ensureRecoveryCopy(true))) return false;
      if (!activeRef.value || activeRef.value.accountId !== accountId.value) return false;
      // Installing the acknowledged copy starts a new save lane for its ref.
      token = generation;
    }
    // A copy receipt whose ref was then deleted is historical, not a save. Keep
    // the exact editor buffer until the user explicitly starts a fresh copy.
    if (recoveryRequired.value) return false;

    if (conflict.value || deleting.value) return false;
    if (!activeRef.value.draftId && activeSource.value?.kind === 'reply' && !createEnvelope
      && ['reply_unavailable', 'not_found'].includes(createError.value?.kind ?? '')) return true;
    if (creating.value) {
      if (!createPromise) {
        if (!createEnvelope || !(await sendCreate(createEnvelope))) return false;
      } else if (!(await createPromise)) return false;
    } else if (createEnvelope && !activeRef.value?.draftId) {
      if (!(await sendCreate(createEnvelope))) return false;
    } else if (createEnvelope && activeRef.value?.draftId) {
      // The create receipt may have arrived before its follow-up read failed. Replay
      // the same create key first, then recover the committed draft without duplication.
      if (!(await sendCreate(createEnvelope))) return false;
    }
    for (;;) {
      if (token !== generation || !activeRef.value || recoveryRequired.value) return false;
      if (inFlight) {
        const waitingLane = saveLaneGeneration;
        const result = await inFlight;
        if (token !== generation || !activeRef.value) return false;
        if (waitingLane !== saveLaneGeneration) continue;
        if (!result) return false;
        continue;
      }
      if (!activeRef.value) return false;
      if (!activeRef.value.draftId || !revision.value) return false;
      let command = retryEnvelope;
      if (!command) {
        if (!dirty.value) return true;
        command = {
          ref: { ...activeRef.value },
          expectedRevision: revision.value,
          requestId: requestId(),
          content: copyContent(content.value),
        };
      }
      if (command.ref.accountId !== activeRef.value.accountId || command.ref.draftId !== activeRef.value.draftId) return false;
      if (!(await sendSave(command, token))) return false;
      // A retry is deliberately sent before any newer buffer. Its ACK advances only
      // the revision and baseline for that frozen payload; newer edits remain dirty.
    }
  }

  async function flushAndClose(): Promise<boolean> {
    cancelDiscard();
    if (!activeRef.value) return true;
    if (!(await flush())) return false;
    clearEditor();
    return true;
  }

  async function switchEditor(): Promise<boolean> {
    cancelDiscard();
    if (!activeRef.value) return true;
    return flushAndClose();
  }

  function cancelReplyPreparation(): boolean {
    if (!canCancelReplyPreparation.value) return false;
    clearEditor();
    void refresh();
    return true;
  }

  async function openNew(source: DraftSource = { kind: 'new_message' }): Promise<boolean> {
    if (transitioning.value || !(await switchEditor()) || transitioning.value) return false;
    if (!accountId.value) {
      createError.value = { kind: 'auth_required' };
      return false;
    }
    const initialContent = source.kind === 'new_message' ? copyContent(EMPTY_CONTENT) : null;
    const token = ++generation;
    activeRef.value = { accountId: accountId.value, draftId: '' };
    activeSource.value = source;
    content.value = copyContent(initialContent ?? EMPTY_CONTENT);
    acknowledged.value = copyContent(initialContent ?? EMPTY_CONTENT);
    revision.value = 0;
    hasReceipt.value = false;
    conflict.value = false;
    error.value = null;
    createError.value = null;
    createEnvelope = {
      requestId: requestId(),
      source,
      initialContent,
    };
    // Reply defaults are core-owned; wait for the receipt and get_draft before editing.
    const isReply = source.kind === 'reply';
    creating.value = isReply;
    if (!isReply) {
      const result = await sendCreate(createEnvelope);
      return token === generation && !!activeRef.value && result;
    }
    const result = await sendCreate(createEnvelope);
    return token === generation && !!activeRef.value && result;
  }

  async function openDraft(ref: DraftRef): Promise<boolean> {
    if (transitioning.value || ref.accountId !== accountId.value || !(await switchEditor()) || transitioning.value) return false;
    const token = ++generation;
    try {
      const draft: Draft = await client.getDraft(ref);
      if (token !== generation || ref.accountId !== accountId.value) return false;
      activeRef.value = { ...draft.ref };
      activeSource.value = draft.source;
      content.value = copyContent(draft.content);
      acknowledged.value = copyContent(draft.content);
      revision.value = draft.revision;
      hasReceipt.value = false;
      conflict.value = false;
      error.value = null;
      createError.value = null;
      void refresh();
      return true;
    } catch (raw) {
      if (token === generation) createError.value = normalizeError(raw);
      return false;
    }
  }

  async function retrySave(): Promise<boolean> {
    if (deleteRetryEnvelope) return sendDelete(deleteRetryEnvelope);
    if (createEnvelope && !creating.value) return sendCreate(createEnvelope);
    return flush();
  }

  function cancelReload(): void {
    reloadAttempt += 1;
    confirmReload.value = false;
  }

  async function reloadSaved(): Promise<boolean> {
    if (!activeRef.value?.draftId || !conflict.value || copyPending.value) return false;
    const target = { ...activeRef.value };
    const token = generation;
    const attempt = ++reloadAttempt;
    try {
      const draft = await client.getDraft(target);
      if (attempt !== reloadAttempt || !confirmReload.value || token !== generation
        || activeRef.value?.draftId !== target.draftId || activeRef.value.accountId !== target.accountId) return false;
      revision.value = draft.revision;
      copyRetryEnvelope.value = null;
      copyRetryOwner = null;
      copyPending.value = false;
      content.value = copyContent(draft.content);
      acknowledged.value = copyContent(draft.content);
      activeSource.value = draft.source;
      conflict.value = false;
      error.value = null;
      hasReceipt.value = false;
      confirmReload.value = false;
      void refresh();
      return true;
    } catch (raw) {
      if (attempt === reloadAttempt && confirmReload.value && token === generation
        && activeRef.value?.draftId === target.draftId && activeRef.value.accountId === target.accountId) {
        error.value = normalizeError(raw);
      }
      return false;
    }
  }

  async function ensureRecoveryCopy(allowTransition: boolean): Promise<boolean> {
    if (copyPromise) return copyPromise;
    const command = copyRetryEnvelope.value;
    const owner = copyRetryOwner;
    if (!command || !owner || !activeRef.value || activeRef.value.accountId !== accountId.value
      || owner.generation !== generation || owner.accountId !== activeRef.value.accountId
      || owner.draftId !== activeRef.value.draftId || (transitioning.value && !allowTransition)) return false;

    const originalToken = generation;
    const originalRef = { ...activeRef.value };
    const originalAccountId = activeRef.value.accountId;
    const stillOwnsEditor = () => originalToken === generation
      && activeRef.value?.accountId === originalRef.accountId
      && activeRef.value.draftId === originalRef.draftId;
    copyPending.value = true;
    const operation = (async () => {
      let receipt: DraftReceipt;
      try {
        receipt = await client.createDraft(command);
      } catch (raw) {
        if (stillOwnsEditor()) {
          const mailError = normalizeError(raw);
          error.value = mailError;
          if (['invalid_request', 'request_id_conflict'].includes(mailError.kind)) {
            copyRetryEnvelope.value = null;
            copyRetryOwner = null;
          }
        }
        return false;
      }
      if (!stillOwnsEditor()) return false;
      if (accountId.value !== originalAccountId || receipt.ref.accountId !== originalAccountId) {
        error.value = { kind: 'auth_required' };
        return false;
      }
      if (!receipt.ref.draftId) {
        error.value = { kind: 'storage_unavailable' };
        return false;
      }

      let saved: Draft;
      try {
        // A create receipt is historical and may name a ref deleted immediately
        // after commit. Only a live, account-scoped read can acknowledge recovery.
        saved = await client.getDraft(receipt.ref);
      } catch (raw) {
        if (!stillOwnsEditor()) return false;
        const mailError = normalizeError(raw);
        error.value = mailError;
        if (mailError.kind === 'not_found') {
          // The accepted create key can only replay its old receipt. Retire it so
          // only an explicit Save-as-new action can create a fresh recovery copy.
          copyRetryEnvelope.value = null;
          copyRetryOwner = null;
          recoveryRequired.value = true;
          conflict.value = false;
          // Ignore any late result from the missing original ref and prevent an
          // old frozen retry from replacing this recovery state or being resent.
          retireSaveLane();
        }
        return false;
      }
      if (!stillOwnsEditor()) return false;
      if (accountId.value !== originalAccountId || saved.ref.accountId !== originalAccountId) {
        error.value = { kind: 'auth_required' };
        return false;
      }
      if (saved.ref.draftId !== receipt.ref.draftId || saved.revision < receipt.revision) {
        error.value = { kind: 'storage_unavailable' };
        return false;
      }

      const latestBuffer = copyContent(content.value);
      const expectedContent = command.initialContent ?? EMPTY_CONTENT;
      const foundNewerRevision = saved.revision !== receipt.revision;
      const unexpectedContent = !sameContent(saved.content, expectedContent);
      // Retire the old ref's save generation only after verifying the replacement.
      // Delayed ACKs/rejections from that lane cannot govern this new ref.
      retireSaveLane();
      activeRef.value = { ...receipt.ref };
      activeSource.value = saved.source;
      revision.value = saved.revision;
      acknowledged.value = copyContent(saved.content);
      hasReceipt.value = true;
      recoveryRequired.value = false;
      conflict.value = foundNewerRevision || unexpectedContent;
      error.value = conflict.value ? { kind: 'draft_conflict', currentRevision: saved.revision } : null;
      createError.value = null;
      copyRetryEnvelope.value = null;
      copyRetryOwner = null;
      copyPending.value = false;
      void refresh();
      if (!conflict.value && !sameContent(latestBuffer, acknowledged.value)) scheduleSave();
      return true;
    })();
    copyPromise = operation;
    try {
      return await operation;
    } finally {
      if (copyPromise === operation) copyPromise = null;
      if (originalToken === generation) copyPending.value = false;
    }
  }

  async function saveAsNew(): Promise<boolean> {
    const recoverableMissingDraft = recoveryRequired.value
      || (error.value?.kind === 'not_found' && !!activeRef.value?.draftId);
    const outstandingRecoverySave = !!activeRef.value?.draftId && (!!retryEnvelope || !!inFlight);
    if (!activeRef.value || activeRef.value.accountId !== accountId.value || transitioning.value
      || !(conflict.value || recoverableMissingDraft || copyRetryEnvelope.value || copyPromise || outstandingRecoverySave)) return false;
    // The user's copy choice wins over an outstanding reload read; that response
    // must not replace the payload being copied or overwrite the installed copy.
    reloadAttempt += 1;
    confirmReload.value = false;
    if (copyPromise) return copyPromise;
    if (copyRetryEnvelope.value && (!copyRetryOwner
      || copyRetryOwner.generation !== generation
      || copyRetryOwner.accountId !== activeRef.value.accountId
      || copyRetryOwner.draftId !== activeRef.value.draftId)) {
      copyRetryEnvelope.value = null;
      copyRetryOwner = null;
    }
    if (!copyRetryEnvelope.value) {
      copyRetryEnvelope.value = {
        requestId: requestId(),
        source: { kind: 'new_message' },
        initialContent: copyContent(content.value),
      };
      copyRetryOwner = {
        generation,
        accountId: activeRef.value.accountId,
        draftId: activeRef.value.draftId,
      };
    }
    return ensureRecoveryCopy(false);
  }

  async function sendDelete(command: DeleteDraft): Promise<boolean> {
    const token = generation;
    const operation = (async () => {
      deleting.value = true;
      deletePending.value = false;
      error.value = null;
      try {
        await client.deleteDraft(command);
        if (token !== generation || activeRef.value?.draftId !== command.ref.draftId || activeRef.value.accountId !== command.ref.accountId) return false;
        deleteRetryEnvelope = null;
        clearEditor();
        confirmDiscard.value = false;
        void refresh();
        return true;
      } catch (raw) {
        if (token !== generation) return false;
        error.value = normalizeError(raw);
        if (error.value.kind === 'draft_conflict') {
          conflict.value = true;
          deleteRetryEnvelope = null;
        } else if (['invalid_request', 'request_id_conflict', 'not_found'].includes(error.value.kind)) {
          // These are definite rejections (or a confirmed prior deletion), not lost ACKs.
          deleteRetryEnvelope = null;
        }
        deletePending.value = deleteRetryEnvelope !== null;
        return false;
      } finally {
        if (token === generation) deleting.value = false;
      }
    })();
    deletePromise = operation;
    const result = await operation;
    if (deletePromise === operation) deletePromise = null;
    return result;
  }

  function askDiscard(): void {
    if (!activeRef.value?.draftId || discardBusy.value || deleting.value || deletePending.value || transitioning.value) return;
    const token = ++discardIntentToken;
    discardIntent = { token, generation, ref: { ...activeRef.value } };
    discardBusy.value = false;
    confirmDiscard.value = true;
  }

  function cancelDiscard(): void {
    if (deleting.value || deletePending.value) return;
    discardIntentToken += 1;
    discardIntent = null;
    discardBusy.value = false;
    confirmDiscard.value = false;
  }

  function discardIntentIsCurrent(intent: { token: number; generation: number; ref: DraftRef }): boolean {
    return discardIntent === intent && intent.token === discardIntentToken
      && intent.generation === generation
      && activeRef.value?.accountId === intent.ref.accountId
      && activeRef.value.draftId === intent.ref.draftId
      && accountId.value === intent.ref.accountId;
  }

  async function discard(): Promise<boolean> {
    const intent = discardIntent;
    if (!intent || !confirmDiscard.value || discardBusy.value || !discardIntentIsCurrent(intent)
      || !activeRef.value?.draftId || conflict.value || creating.value || transitioning.value) return false;
    if (deleteRetryEnvelope) return sendDelete(deleteRetryEnvelope);
    discardBusy.value = true;
    const alreadyRejectedBuffer = error.value?.kind === 'invalid_request' && !retryEnvelope;
    const flushed = alreadyRejectedBuffer ? false : await flush();
    if (!discardIntentIsCurrent(intent) || !confirmDiscard.value || transitioning.value) return false;
    const definitelyRejectedBuffer = error.value?.kind === 'invalid_request' && !retryEnvelope;
    if ((!flushed && !definitelyRejectedBuffer) || !activeRef.value?.draftId || conflict.value) {
      discardBusy.value = false;
      return false;
    }
    const command: DeleteDraft = {
      ref: { ...intent.ref },
      expectedRevision: revision.value,
      requestId: requestId(),
    };
    // Confirmation only cancels before dispatch. Once sent, the frozen revision-
    // checked delete is either completed or retried with the same request envelope.
    discardIntentToken += 1;
    discardIntent = null;
    confirmDiscard.value = false;
    discardBusy.value = false;
    deleteRetryEnvelope = command;
    clearTimer();
    return sendDelete(command);
  }

  function setContent(field: keyof DraftContent, value: string): void {
    const correctingCopyValidation = conflict.value && error.value?.kind === 'invalid_request' && !copyRetryEnvelope.value;
    if (!activeRef.value || transitioning.value || closingForWindow.value || (creating.value && activeSource.value?.kind === 'reply') || deleting.value || deletePending.value || (conflict.value && !correctingCopyValidation)) return;
    content.value = { ...content.value, [field]: value };
    if (!correctingCopyValidation && !recoveryRequired.value) error.value = null;
    if (createError.value?.kind === 'invalid_request') createError.value = null;
    scheduleSave();
  }

  function staleCloseRequest(raw: unknown): boolean {
    const mailError = normalizeError(raw);
    return mailError.kind === 'invalid_request' && mailError.field === 'requestId';
  }

  async function handleCloseRequest(request: AppCloseRequest, retry = false): Promise<void> {
    if (detached || (!retry && request.requestId === lastCloseRequestId)) return;
    const token = ++closeToken;
    lastCloseRequestId = request.requestId;
    completionDispatched = false;
    closeRetryAvailable.value = false;
    closingForWindow.value = true;
    closeError.value = null;
    const submittedEditorGeneration = generation;
    const okay = await flush();
    if (token !== closeToken || lastCloseRequestId !== request.requestId) return;
    if (!okay || submittedEditorGeneration !== generation) {
      closeError.value = error.value ? errorMessage(error.value) : createError.value ? errorMessage(createError.value) : 'The latest draft was not confirmed. The editor remains open.';
      try {
        await client.cancelAppClose(request.requestId);
        if (token === closeToken) {
          lastCloseRequestId = null;
          closeRetryAvailable.value = false;
          closeError.value = null;
          closingForWindow.value = false;
        }
      } catch (raw) {
        if (token !== closeToken) return;
        if (staleCloseRequest(raw)) {
          lastCloseRequestId = null;
          closeRetryAvailable.value = false;
        } else {
          closeRetryAvailable.value = true;
          closeError.value = `${closeError.value} Close is still pending; retry close recovery.`;
        }
        closingForWindow.value = false;
      }
      return;
    }
    if (completionDispatched) return;
    completionDispatched = true;
    try {
      await client.completeAppClose(request.requestId);
      if (token === closeToken) closeRetryAvailable.value = false;
      if (token === closeToken && mode === 'browser-preview') closingForWindow.value = false;
    } catch (raw) {
      if (token !== closeToken) return;
      if (staleCloseRequest(raw)) {
        lastCloseRequestId = null;
        closeRetryAvailable.value = false;
        closingForWindow.value = false;
        closeError.value = 'The close request is no longer current. The editor remains open.';
      } else {
        // Completion delivery is ambiguous. Keep editing locked until the exact ID is
        // reconciled or a retry confirms the native response.
        closeRetryAvailable.value = true;
        closeError.value = 'Close completion was not confirmed. Retry this close request; editing remains locked.';
        closingForWindow.value = true;
      }
    }
  }

  async function retryClose(): Promise<void> {
    if (lastCloseRequestId) {
      await handleCloseRequest({ requestId: lastCloseRequestId }, true);
      return;
    }
    await retryCloseSetup();
  }

  async function retryDraftSubscription(): Promise<void> {
    try {
      await ensureDraftSubscription();
      await refresh();
    } catch {
      // ensureDraftSubscription retains the visible failure until a listener installs.
    }
  }

  async function retryCloseSetup(): Promise<void> {
    try {
      await ensureCloseSubscription();
      closeSetupError.value = null;
    } catch (raw) {
      closeSetupError.value = errorMessage(normalizeError(raw));
    }
  }

  function setTransitioning(value: boolean): void {
    if (value) cancelDiscard();
    transitioning.value = value;
  }

  async function ensureCloseSubscription(): Promise<void> {
    if (unsubscribeClose || detached) return;
    if (!closeSubscriptionAttempt) {
      closeSubscriptionAttempt = client.subscribeAppClose((request) => { void handleCloseRequest(request); })
        .then((unlisten) => {
          if (detached) unlisten();
          else unsubscribeClose = unlisten;
          closeSetupError.value = null;
        })
        .finally(() => { closeSubscriptionAttempt = null; });
    }
    await closeSubscriptionAttempt;
  }

  function onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!hasUnsavedWork.value) return;
    event.preventDefault();
    event.returnValue = '';
  }

  function onReconnectOrFocus(): void {
    void (async () => {
      try {
        await ensureDraftSubscription();
      } catch {
        // Subscription failure is displayed separately from list-read status.
      }
      await refresh();
    })();
    void ensureCloseSubscription().catch((raw) => { closeSetupError.value = errorMessage(normalizeError(raw)); });
  }

  watch(accountId, () => {
    cancelDiscard();
    listToken += 1;
    summaries.value = [];
    void refresh();
  }, { flush: 'sync' });

  onMounted(() => {
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('focus', onReconnectOrFocus);
    window.addEventListener('online', onReconnectOrFocus);
    void (async () => {
      try {
        // Subscribe before the first read, so no local change is missed.
        await ensureDraftSubscription();
      } catch {
        // Keep subscription failure visible even if this list read succeeds.
      }
      await refresh();
    })();
    void ensureCloseSubscription().catch((raw) => {
      closeSetupError.value = errorMessage(normalizeError(raw));
    });
  });

  onBeforeUnmount(() => {
    detached = true;
    generation += 1;
    listToken += 1;
    closeToken += 1;
    clearTimer();
    unsubscribeDrafts?.();
    unsubscribeClose?.();
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('focus', onReconnectOrFocus);
    window.removeEventListener('online', onReconnectOrFocus);
  });

  return {
    summaries, listError, draftSubscriptionError, activeRef, activeSource, content, revision, acknowledged,
    hasReceipt, creating, saving, conflict, error, createError, deleting, closingForWindow,
    closeError, closeRetryAvailable, closeSetupError, confirmDiscard, discardBusy, confirmReload, copyPending, copyRetryEnvelope,
    isVisible, canCancelReplyPreparation, recoveryRequired,
    transitioning, deletePending, dirty, hasUnsavedWork, statusLabel, refresh, openNew, openDraft, flush, flushAndClose,
    retrySave, reloadSaved, cancelReload, saveAsNew, askDiscard, discard, cancelDiscard, cancelReplyPreparation, setContent, scheduleSave, setTransitioning,
    retryDraftSubscription, retryClose, retryCloseSetup,
  };
}
