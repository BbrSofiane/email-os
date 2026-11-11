import { describe, expect, it } from 'vitest';
import { createSubjectIndex } from '../../src/lib/subject-index';

const ref = (conversationId: string, accountId = 'acct') => ({ accountId, conversationId });

describe('session subject index', () => {
  it('returns null for a ref that was never seen, never an id', () => {
    const index = createSubjectIndex();
    expect(index.subjectFor(ref('conv-1'))).toBeNull();
    expect(index.size).toBe(0);
  });

  it('remembers rows by account and conversation, and keeps accounts apart', () => {
    const index = createSubjectIndex();
    index.rememberRows([
      { ref: ref('conv-1'), subject: 'Quarterly plan' },
      { ref: ref('conv-1', 'other'), subject: 'Different mailbox' },
    ]);
    expect(index.subjectFor(ref('conv-1'))).toBe('Quarterly plan');
    expect(index.subjectFor(ref('conv-1', 'other'))).toBe('Different mailbox');
    expect(index.subjectFor(ref('conv-2'))).toBeNull();
  });

  it('keeps an empty subject as seen (not unknown) and lets a later sighting replace an earlier one', () => {
    const index = createSubjectIndex();
    index.remember(ref('conv-1'), '');
    expect(index.subjectFor(ref('conv-1'))).toBe('');
    index.remember(ref('conv-1'), 'Renamed thread');
    expect(index.subjectFor(ref('conv-1'))).toBe('Renamed thread');
    expect(index.size).toBe(1);
  });
});
