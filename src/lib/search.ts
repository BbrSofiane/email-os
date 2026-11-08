import type { Conversation } from './ipc/client';
/** Synthetic preview mirror of the Rust-owned grammar; not a provider query. */
export function parseSearch(input: string): { field: string; value: string; excluded: boolean }[][] {
  const fail = (): never => { throw { kind: 'invalid_request', field: 'searchQuery' }; };
  if (!input.trim() || new TextEncoder().encode(input).length > 512) fail();
  const tokens: string[] = [];
  let token = '', quoted = false;
  for (const c of input) {
    if (c === '"') { quoted = !quoted; token += c; }
    else if ((!quoted && /[(){}\\]/.test(c)) || /[\x00-\x1f\x7f]/.test(c)) fail();
    else if (/\s/.test(c) && !quoted) { if (token) tokens.push(token); token = ''; }
    else token += c;
  }
  if (quoted) fail();
  if (token) tokens.push(token);
  const groups: ReturnType<typeof parseSearch> = [[]];
  let needsTerm = true;
  for (let raw of tokens) {
    if (raw === 'OR' || raw === 'AND') {
      if (needsTerm) fail();
      if (raw === 'OR') groups.push([]);
      needsTerm = true;
      continue;
    }
    const excluded = raw.startsWith('-');
    if (excluded) raw = raw.slice(1);
    const colon = raw.startsWith('"') ? -1 : raw.indexOf(':');
    const field = colon < 0 ? 'text' : raw.slice(0, colon);
    let value = colon < 0 ? raw : raw.slice(colon + 1);
    if (!['text', 'from', 'to', 'subject'].includes(field)) fail();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    else if (value.includes('"')) fail();
    if (!value) fail();
    groups.at(-1)!.push({ field, value: value.toLowerCase(), excluded });
    needsTerm = false;
  }
  if (needsTerm) fail();
  return groups;
}
/**
 * Frontend mirror of the Rust-owned grammar (see parseSearch above): returns a
 * specific plain-language problem for inline feedback while typing, or null
 * when the query is valid. Rust still owns validation at the wire; this only
 * gates the local submit so an invalid query never reaches searchMail.
 * The 512 limit counts UTF-8 bytes, not characters (the input's maxlength
 * counts characters), so it is measured with TextEncoder exactly like
 * parseSearch does.
 */
export function validateSearch(input: string): string | null {
  if (!input.trim()) return 'The query is empty — type a term, a "phrase", or an operator like from:.';
  const bytes = new TextEncoder().encode(input).length;
  if (bytes > 512) return `Query is ${bytes} bytes — the limit is 512 bytes (UTF-8, not characters). Shorten it.`;
  const tokens: string[] = [];
  let token = '', quoted = false;
  for (const c of input) {
    if (c === '"') { quoted = !quoted; token += c; }
    else if (!quoted && /[(){}\\]/.test(c)) return `"${c}" is not supported — parentheses, braces and backslashes are not part of the search grammar.`;
    else if (/[\x00-\x1f\x7f]/.test(c)) return 'Control characters are not allowed in a query.';
    else if (/\s/.test(c) && !quoted) { if (token) tokens.push(token); token = ''; }
    else token += c;
  }
  if (quoted) return 'Unmatched " — close the quoted phrase.';
  if (token) tokens.push(token);
  let needsTerm = true;
  for (let raw of tokens) {
    if (raw === 'OR' || raw === 'AND') {
      if (needsTerm) return `"${raw}" needs a term on both sides.`;
      needsTerm = true;
      continue;
    }
    const excluded = raw.startsWith('-');
    if (excluded) raw = raw.slice(1);
    const colon = raw.startsWith('"') ? -1 : raw.indexOf(':');
    const field = colon < 0 ? 'text' : raw.slice(0, colon);
    let value = colon < 0 ? raw : raw.slice(colon + 1);
    if (!['text', 'from', 'to', 'subject'].includes(field)) return `Unknown operator "${field}:" — supported operators are from:, to: and subject:.`;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    else if (value.includes('"')) return 'A quote must wrap a whole phrase, e.g. "exact words".';
    if (!value) return field === 'text' ? 'Missing value after "-".' : `"${field}:" needs a value — e.g. ${field}:"example".`;
    needsTerm = false;
  }
  if (needsTerm) return 'The query ends with an operator — add a term after it.';
  return null;
}
/**
 * P5b sender-grouping trigger: returns the from value when the query parses to
 * exactly one OR-group holding exactly one non-excluded from: term (the
 * contact-pane path, e.g. from:"ada@example.test"), otherwise null. Pure: an
 * invalid query is simply not a single-from query, never an error here.
 * The value is lowercased like every parsed value; callers only need the
 * non-null signal, because rows are grouped by their actual sender.
 */
export function isSingleFromQuery(input: string): string | null {
  let groups: ReturnType<typeof parseSearch>;
  try {
    groups = parseSearch(input);
  } catch {
    return null;
  }
  if (groups.length !== 1 || groups[0]!.length !== 1) return null;
  const term = groups[0]![0]!;
  if (term.field !== 'from' || term.excluded) return null;
  return term.value;
}

/** Minimal row shape needed for sender grouping (ConversationSummary satisfies it). */
export interface SenderGroupRow {
  primaryCorrespondent?: { displayName: string | null; mailbox: string } | undefined;
  participants: Array<{ mailbox: string }>;
}

/**
 * P5b grouping key: the exact sender mailbox — the primary correspondent's,
 * else the first participant's. Never a guessed contact.
 */
export function senderGroupKey(row: SenderGroupRow): string {
  return row.primaryCorrespondent?.mailbox ?? row.participants[0]?.mailbox ?? 'unknown-sender';
}

/** P5b group caption label: the display name, else the mailbox. */
export function senderGroupLabel(row: SenderGroupRow): string {
  const mailbox = row.primaryCorrespondent?.mailbox ?? row.participants[0]?.mailbox;
  if (mailbox === undefined) return 'Unknown sender';
  return row.primaryCorrespondent?.displayName ?? mailbox;
}

/**
 * P5b stable sender bucketing: groups appear in first-seen order and rows keep
 * their incoming order inside each group (never re-sorted). Pure, so the list
 * rendering and the keyboard navigation order share one definition.
 */
export function groupRowsBySender<T>(rows: readonly T[], keyOf: (row: T) => string): T[] {
  const buckets = new Map<string, T[]>();
  const order: string[] = [];
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else {
      buckets.set(key, [row]);
      order.push(key);
    }
  }
  const out: T[] = [];
  for (const key of order) out.push(...buckets.get(key)!);
  return out;
}
export function matchesSearch(query: ReturnType<typeof parseSearch>, conversation: Conversation): boolean {
  const address = (a: { displayName: string | null; mailbox: string }): string => `${a.displayName ?? ''} ${a.mailbox}`;
  const from = conversation.messages.map((m) => address(m.from)).join('\n').toLowerCase();
  const to = conversation.messages.flatMap((m) => m.to.map(address)).join('\n').toLowerCase();
  const subject = conversation.subject.toLowerCase();
  const text = [subject, from, to, conversation.messages.map((m) => m.bodyText).join('\n')].join('\n').toLowerCase();
  const fields: Record<string, string> = { from, to, subject, text };
  return query.some((group) => group.every((term) => fields[term.field]!.includes(term.value) !== term.excluded));
}
