import type { ConversationSummary, SavedSplit } from './ipc/client';

/** Latest message's sender only, never recipients, names, body, or inference. */
export function matchesSplit(row: ConversationSummary, split: SavedSplit): boolean {
  const mailbox = row.primaryCorrespondent?.mailbox.trim().toLowerCase();
  if (!mailbox) return false;
  return split.criterion === 'sender' ? mailbox === split.value
    : mailbox.slice(mailbox.lastIndexOf('@') + 1) === split.value && mailbox.includes('@');
}

/** Total conversations, not unread; never manufacture 0 or 999+. */
export function splitBadge(total: number | null): string | null {
  return total !== null && Number.isInteger(total) && total >= 1 && total <= 999 ? String(total) : null;
}

/** Preview validation mirrors the bounded Rust definition; native revalidates. */
export function normalizeSplit(split: SavedSplit): SavedSplit {
  const normalized = { ...split, name: split.name.trim(), value: split.value.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase()) };
  const domain = (s: string): boolean => s.length > 0 && s.length <= 253 && s.split('.').every(
    (part) => part.length > 0 && part.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part));
  const parts = normalized.value.split('@');
  const valid = split.criterion === 'domain' ? domain(normalized.value)
    : parts.length === 2 && parts[0]!.length <= 64 && /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+$/.test(parts[0]!) && domain(parts[1]!);
  if (!valid || !normalized.name || [...normalized.name].length > 40 || /[\u0000-\u001f\u007f-\u009f]/.test(normalized.name)) {
    throw { kind: 'invalid_request', field: 'savedSplit' };
  }
  return normalized;
}
