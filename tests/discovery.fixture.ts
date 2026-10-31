/** Synthetic UX-03 fixture shared by component and real-Chrome tests; no IPC/native storage. */
import type { ConversationSummary, MailClient, MailError } from '../src/lib/ipc/client';
import { createReaderFixtureClient, readerRef } from './reader.fixture';

export function createDiscoveryFixture() {
  const reader = createReaderFixtureClient();
  const archived = new Set<string>();
  let delay = 0;
  let error: MailError | null = null;
  let enabled = true;
  let doneCalls = 0;
  const client: MailClient = {
    ...reader.client,
    getAccountStatus: async () => ({ ...(await reader.client.getAccountStatus()), mode: 'gmail', mutationAccess: enabled ? 'enabled' : 'read_only' }),
    listCachedDone: async (request: { accountId: string; limit: number; cursor: string | null }) => {
      doneCalls++;
      if (request.accountId !== 'reader-account') throw { kind: 'invalid_request', field: 'accountId' };
      const failure = error;
      error = null;
      const conversations: ConversationSummary[] = [];
      for (const id of archived) {
        const detail = await reader.client.getConversation(readerRef(id));
        const last = detail.messages[detail.messages.length - 1]!;
        conversations.push({ ref: detail.ref, subject: detail.subject, preview: last.bodyText, participants: [last.from], primaryCorrespondent: last.from, lastMessageAt: last.sentAt, pendingOperationId: null });
      }
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (failure) throw failure;
      return { conversations, nextCursor: null, coverage: 'local_cache', exactTotal: null, lastSyncedAt: null };
    },
    setArchived: async (command) => {
      if (command.archived) archived.add(command.conversation.conversationId);
      else archived.delete(command.conversation.conversationId);
      return reader.client.setArchived(command);
    },
  };
  return {
    client,
    controls: reader.controls,
    archived,
    seedDone: async (id = 'read-01') => { await client.setArchived({ conversation: readerRef(id), archived: true, requestId: `seed-${id}` }); reader.controls.archiveCommands.length = 0; reader.controls.detailCalls.length = 0; },
    delayDone: (ms: number) => { delay = ms; },
    failDone: (failure: MailError) => { error = failure; },
    setEnabled: (value: boolean) => { enabled = value; reader.controls.notify(); },
    doneCalls: () => doneCalls,
  };
}
