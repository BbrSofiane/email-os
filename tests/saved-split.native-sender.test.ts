import { expect, it } from 'vitest';
import summaries from './fixtures/newest-sender-summaries.json';
import type { ConversationSummary, SavedSplit } from '../src/lib/ipc/client';
import { matchesSplit } from '../src/lib/saved-split';

it('projects actual native provider/cache summaries, not the older renderable sender or recipients', () => {
  // Rust newest_sender_provider_storage_and_membership_wire_contract asserts
  // this exact wire fixture against provider parsing, storage and list results.
  const [bob, unknown] = summaries as ConversationSummary[];
  const rule = (criterion: SavedSplit['criterion'], value: string): SavedSplit => ({
    name: 'Clients', enabled: true, hideWhenEmpty: false, criterion, value,
  });
  for (const [criterion, newest, older] of [
    ['sender', 'bob@new.test', 'alice@old.test'],
    ['domain', 'new.test', 'old.test'],
  ] as const) {
    expect(matchesSplit(bob!, rule(criterion, newest))).toBe(true);
    expect(matchesSplit(bob!, rule(criterion, older))).toBe(false);
    expect(matchesSplit(unknown!, rule(criterion, newest))).toBe(false);
    expect(matchesSplit(unknown!, rule(criterion, older))).toBe(false);
  }
});
