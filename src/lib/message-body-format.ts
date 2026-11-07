/**
 * Decides whether a plain-text message body keeps the monospace face.
 *
 * Prose reads in the proportional UI face. Hard-wrapped text that depends on
 * column alignment (quoted replies, indented blocks, code, ASCII tables) loses
 * its meaning there, so it falls back to the raw monospace rendering. The test
 * is deterministic and looks only at line shapes; the body is never rewritten.
 */
export function bodyNeedsMonospace(bodyText: string): boolean {
  const lines = bodyText.split('\n');
  let indentedRun = 0;
  let pipeLines = 0;
  for (const line of lines) {
    // Quoted reply line: optional indent, then ">".
    if (/^ {0,3}>/.test(line)) return true;
    // Two consecutive lines with 4+ leading spaces (or a tab): code, tables, signatures.
    if (/^(?: {4,}|\t)\S/.test(line)) {
      indentedRun += 1;
      if (indentedRun >= 2) return true;
    } else {
      indentedRun = 0;
    }
    // Table-ish: two or more lines with at least two pipes.
    if ((line.match(/\|/g)?.length ?? 0) >= 2) {
      pipeLines += 1;
      if (pipeLines >= 2) return true;
    }
  }
  return false;
}
