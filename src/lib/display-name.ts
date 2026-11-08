/**
 * Bidirectional control characters: embeddings, overrides, isolates, marks and
 * the Arabic letter mark. A sender controls a file name, and U+202E (RLO) can
 * make "invoice‮fdp.exe" display as "invoiceexe.pdf". Names are shown with
 * these removed, so what is read is the real character order.
 */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

/** A file name safe to print: bidi controls stripped, the empty name replaced. */
export function displayFileName(filename: string | null | undefined): string {
  const name = (filename ?? '').replace(BIDI_CONTROLS, '');
  return name.trim() === '' ? 'Unnamed attachment' : name;
}
