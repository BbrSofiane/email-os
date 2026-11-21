import { isTauriRuntime } from './ipc';

/** ADR 0006 decision 13: a later stage enables Android link dispatch. */
export function externalLinksAvailable(): boolean {
  return !(isTauriRuntime() && /Android/i.test(navigator.userAgent));
}

/** Whether a link's visible text names a different host than its destination (ADR 0006 decision 11). */
export function linkHostMismatch(url: string, text: string): boolean {
  const visible = text.trim();
  if (!visible.includes('.') || /\s/.test(visible)) return false;
  try {
    const destination = new URL(url);
    if (destination.protocol === 'mailto:') return false;
    const shown = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(visible) ? visible : `https://${visible}`);
    // Only text that reads as a host (ends in an alphabetic TLD) counts; "v1.2" or "e.g." do not.
    if (!/\.[a-z]{2,}$/i.test(shown.hostname)) return false;
    const normalize = (host: string) => host.toLowerCase().replace(/^www\./, '');
    return normalize(shown.hostname) !== normalize(destination.hostname);
  } catch {
    return false;
  }
}

/** First address of a mailto: URL; every query parameter is ignored (ADR 0006 decision 12). */
export function mailtoAddress(url: string): string | null {
  if (!/^mailto:/i.test(url)) return null;
  try {
    const address = decodeURIComponent(url.slice(7).split('?')[0] ?? '').split(',')[0] ?? '';
    return /^[^\s\x00-\x1f\x7f,@]+@[^\s\x00-\x1f\x7f,@.]+(?:\.[^\s\x00-\x1f\x7f,@.]+)+$/.test(address) ? address : null;
  } catch {
    return null;
  }
}
