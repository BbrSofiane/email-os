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
export function matchesSearch(query: ReturnType<typeof parseSearch>, conversation: Conversation): boolean {
  const address = (a: { displayName: string | null; mailbox: string }): string => `${a.displayName ?? ''} ${a.mailbox}`;
  const from = conversation.messages.map((m) => address(m.from)).join('\n').toLowerCase();
  const to = conversation.messages.flatMap((m) => m.to.map(address)).join('\n').toLowerCase();
  const subject = conversation.subject.toLowerCase();
  const text = [subject, from, to, conversation.messages.map((m) => m.bodyText).join('\n')].join('\n').toLowerCase();
  const fields: Record<string, string> = { from, to, subject, text };
  return query.some((group) => group.every((term) => fields[term.field]!.includes(term.value) !== term.excluded));
}
