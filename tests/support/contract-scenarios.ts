/**
 * Shared contract scenarios (ticket 17): format helpers for the TypeScript runner.
 * The Rust runner (crates/mail-core/tests/contract_scenarios.rs) implements the
 * same rules; the format is documented in docs/development.md ("Contract
 * scenarios"). Keep the two in step.
 */
export const CLOCK_START = '2026-02-01T00:00:00Z';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Step {
  name?: string;
  do: { cmd?: string; args?: Record<string, Json>; advance?: number; provider?: string };
  expect: { ok?: Json; error?: Json; snapshot?: Record<string, Json> };
}

export interface MailboxJson {
  conversations: Array<{
    id: string;
    messages: Array<{ id: string; sentAt: string; inInbox: boolean; unread: boolean; starred?: boolean | null }>;
  }>;
}

export interface Scenario {
  scenario: string;
  description: string;
  profiles: Array<'gmail' | 'fixture'>;
  mailbox: string | MailboxJson;
  steps: Step[];
}

/** Symbolic ids: `$name` binds on first appearance and must agree afterwards. */
export class Bindings {
  forward = new Map<string, string>();
  reverse = new Map<string, string>();

  clone(): Bindings {
    const copy = new Bindings();
    copy.forward = new Map(this.forward);
    copy.reverse = new Map(this.reverse);
    return copy;
  }

  bind(name: string, actual: string): string | null {
    const bound = this.forward.get(name);
    if (bound !== undefined) return bound === actual ? null : `$${name} was ${JSON.stringify(bound)} but is now ${JSON.stringify(actual)}`;
    const other = this.reverse.get(actual);
    if (other !== undefined) return `$${name} and $${other} are the same value ${JSON.stringify(actual)}`;
    this.forward.set(name, actual);
    this.reverse.set(actual, name);
    return null;
  }
}

export function offsetSeconds(iso: string): number | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.round((parsed - Date.parse(CLOCK_START)) / 1000);
}

function short(value: unknown): string {
  const text = JSON.stringify(value) ?? 'undefined';
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/**
 * Subset match: every key in `expected` must match; `null` also matches an
 * absent key; arrays match element-for-element and length-for-length;
 * `{$length, $each}` checks an array's length / every element; `$name` binds
 * or checks a symbolic id; `@+N` is a clock offset in seconds from the start.
 * Returns an error message, or null when it matches.
 */
export function match(expected: Json, actual: unknown, path: string, bindings: Bindings): string | null {
  if (typeof expected === 'string' && expected.startsWith('$')) {
    if (typeof actual !== 'string') return `${path}: expected a string for ${expected}, got ${short(actual)}`;
    const problem = bindings.bind(expected.slice(1), actual);
    return problem ? `${path}: ${problem}` : null;
  }
  if (typeof expected === 'string' && expected.startsWith('@+')) {
    const want = Number(expected.slice(2));
    const got = typeof actual === 'string' ? offsetSeconds(actual) : null;
    return got === want ? null : `${path}: expected clock offset +${want}s, got ${short(actual)} (${got})`;
  }
  if (expected === null) {
    return actual === null || actual === undefined ? null : `${path}: expected null/absent, got ${short(actual)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array, got ${short(actual)}`;
    if (expected.length !== actual.length) {
      return `${path}: expected ${expected.length} items, got ${actual.length}: ${short(actual)}`;
    }
    for (let index = 0; index < expected.length; index += 1) {
      const problem = match(expected[index] as Json, actual[index], `${path}[${index}]`, bindings);
      if (problem) return problem;
    }
    return null;
  }
  if (typeof expected === 'object') {
    if ('$each' in expected || '$length' in expected) {
      if (!Array.isArray(actual)) return `${path}: expected an array, got ${short(actual)}`;
      const length = expected['$length'];
      if (typeof length === 'number' && actual.length !== length) return `${path}: expected ${length} items, got ${actual.length}`;
      const each = expected['$each'];
      if (each !== undefined) {
        for (let index = 0; index < actual.length; index += 1) {
          const problem = match(each as Json, actual[index], `${path}[${index}]`, bindings);
          if (problem) return problem;
        }
      }
      return null;
    }
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
      return `${path}: expected an object, got ${short(actual)}`;
    }
    for (const [key, want] of Object.entries(expected)) {
      const problem = match(want, (actual as Record<string, unknown>)[key], `${path}.${key}`, bindings);
      if (problem) return problem;
    }
    return null;
  }
  return expected === actual ? null : `${path}: expected ${short(expected)}, got ${short(actual)}`;
}

/** Replaces `$name` strings with their bound values (command arguments). */
export function substitute(value: Json, bindings: Bindings): Json {
  if (typeof value === 'string' && value.startsWith('$')) {
    const bound = bindings.forward.get(value.slice(1));
    if (bound === undefined) throw new Error(`argument refers to unbound symbol ${value}`);
    return bound;
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, bindings));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, bindings)]));
  }
  return value;
}

/**
 * Argument shorthand shared with the Rust runner: a string `conversation` or
 * member is a ref in the backend's own account, `{account, id}` names another
 * account, `{generate: {prefix, count}}` expands to `prefix + 1-based index
 * zero-padded to 3`, and `accountId` defaults to the backend's account.
 */
export function normalizeArgs(command: string, args: Record<string, Json>, account: string): Record<string, Json> {
  const result: Record<string, Json> = { ...args };
  const reference = (value: Json): Json => {
    if (typeof value === 'string') return { accountId: account, conversationId: value };
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'id' in value) {
      return { accountId: typeof value['account'] === 'string' ? value['account'] : account, conversationId: value['id'] as Json };
    }
    return value;
  };
  if ('conversation' in result) result['conversation'] = reference(result['conversation'] as Json);
  if ('members' in result) {
    const members = result['members'] as Json;
    let expanded: Json[];
    if (Array.isArray(members)) expanded = members;
    else if (members !== null && typeof members === 'object' && 'generate' in members) {
      const spec = members['generate'] as { prefix: string; count: number };
      expanded = Array.from({ length: spec.count }, (_, i) => `${spec.prefix}${String(i + 1).padStart(3, '0')}`);
    } else throw new Error('members must be an array or a generate spec');
    result['members'] = expanded.map(reference);
  }
  const groupCommand = ['setArchivedGroup', 'setReadGroup', 'setStarredGroup', 'getOperationGroup', 'listOperationGroups'].includes(command);
  if (groupCommand && !('accountId' in result)) result['accountId'] = account;
  if (command === 'listOperationGroups' && !('cursor' in result)) result['cursor'] = null;
  return result;
}

/** `snapshot.inbox: [ids]` is shorthand for the matching `conversations` list. */
export function expandSnapshot(want: Record<string, Json>): Record<string, Json> {
  const result = { ...want };
  const inbox = result['inbox'];
  if (inbox !== undefined) {
    delete result['inbox'];
    result['conversations'] = (inbox as string[]).map((id) => ({ ref: { conversationId: id } }));
  }
  return result;
}

/** Restricts a snapshot to the scenario's declared conversations. */
export function restrictToDeclared<T extends { conversations: Array<{ ref: { conversationId: string } }>; activity: Array<{ conversation: { conversationId: string } }> }>(
  snapshot: T,
  declared: string[],
): T {
  return {
    ...snapshot,
    conversations: snapshot.conversations.filter((row) => declared.includes(row.ref.conversationId)),
    activity: snapshot.activity.filter((row) => declared.includes(row.conversation.conversationId)),
  };
}

export const MUTATING = [
  'setArchived', 'setRead', 'setStarred', 'retryOperation', 'undoOperation', 'setArchivedGroup',
  'setReadGroup', 'setStarredGroup', 'undoOperationGroup',
];
