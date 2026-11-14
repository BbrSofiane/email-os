import { describe, expect, it } from 'vitest';
import { errorText } from '../../src/lib/error-text';

describe('errorText', () => {
  it('gives search syntax errors actionable text without the banner punctuation', () => {
    expect(errorText({ kind: 'invalid_request', field: 'searchQuery' })).toBe('unsupported search syntax. Use text, straight-quoted phrases, from:, to:, subject:, AND, OR and -exclusions');
  });

  it('provides a fallback for an unknown error and undo reason', () => {
    expect(errorText({ kind: 'unexpected' })).toBe('unknown error');
    expect(errorText({ kind: 'undo_unavailable', reason: 'unexpected' })).toBe('undo unavailable');
  });
});
