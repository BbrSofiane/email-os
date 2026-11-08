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

export interface MessageBodyParts {
  /** The prose part. Equals the whole body when nothing is split off. */
  main: string;
  /** From an RFC 3676 `-- ` delimiter line to the trailing quote or the end. */
  signature: string | null;
  /** The trailing quoted block, from its attribution line (if any) to the end. */
  quoted: string | null;
}

const QUOTE_LINE = /^ {0,3}>/;
const ATTRIBUTION = /^On .+ wrote:$/i;
const ORIGINAL_MESSAGE = /^-{2,}\s*Original Message\s*-{2,}$/i;
/** Exactly the RFC 3676 delimiter: dash, dash, space. A bare "--" is ordinary prose (dimming real content would misrepresent it). */
const SIGNATURE_DELIMITER = /^-- $/;
const MAX_SIGNATURE_LINES = 12;

/**
 * Splits a plain-text body into prose, an optional signature and an optional
 * trailing quote. Deterministic and lossless: the parts are contiguous slices,
 * so `main + (signature ?? '') + (quoted ?? '')` is always the exact original
 * text, line breaks included. Nothing is rewritten, and `>` characters stay.
 *
 * - Trailing quote: an attribution ("On … wrote:", which may wrap onto two
 *   lines, or "-----Original Message-----") followed by blank lines and a
 *   contiguous run of `>` lines that reaches the end of the body, or a bare run
 *   of at least two `>` lines that reaches the end. Quotes in the middle of a
 *   body are never split off.
 * - Signature: the last line that is exactly `-- ` (a bare `--` is not one), only when at most 12
 *   lines follow it before the quote or the end of the body.
 * - A body that would be left with no prose (all quote) is returned unsplit.
 */
export function splitMessageBody(bodyText: string): MessageBodyParts {
  const whole: MessageBodyParts = { main: bodyText, signature: null, quoted: null };
  const lines = bodyText.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const text = (index: number): string => lines[index]!.replace(/\r$/, '');
  const blank = (index: number): boolean => text(index).trim() === '';

  let lastContent = lines.length - 1;
  while (lastContent >= 0 && blank(lastContent)) lastContent -= 1;
  if (lastContent < 0) return whole;

  // Trailing quote.
  let quoteLine = -1;
  if (QUOTE_LINE.test(text(lastContent))) {
    let runStart = lastContent;
    while (runStart > 0 && QUOTE_LINE.test(text(runStart - 1))) runStart -= 1;
    let before = runStart - 1;
    while (before >= 0 && blank(before)) before -= 1;
    if (before >= 0 && (ATTRIBUTION.test(text(before)) || ORIGINAL_MESSAGE.test(text(before)))) {
      quoteLine = before;
    } else if (before >= 1 && /wrote:$/i.test(text(before)) && !blank(before - 1)
      && ATTRIBUTION.test(`${text(before - 1)} ${text(before)}`)) {
      quoteLine = before - 1;
    } else if (lastContent - runStart + 1 >= 2) {
      quoteLine = runStart;
    }
  }
  const quoteStart = quoteLine >= 0 ? starts[quoteLine]! : bodyText.length;
  const regionEnd = quoteLine >= 0 ? quoteLine : lastContent + 1;

  // Signature: the last delimiter before the quote with a short tail.
  let signatureStart = -1;
  for (let i = regionEnd - 1; i >= 0; i -= 1) {
    if (!SIGNATURE_DELIMITER.test(text(i))) continue;
    let tailEnd = regionEnd;
    while (tailEnd > i + 1 && blank(tailEnd - 1)) tailEnd -= 1;
    if (tailEnd - (i + 1) <= MAX_SIGNATURE_LINES) signatureStart = starts[i]!;
    break;
  }

  const mainEnd = signatureStart >= 0 ? signatureStart : quoteStart;
  const main = bodyText.slice(0, mainEnd);
  if (main.trim() === '') return whole;
  return {
    main,
    signature: signatureStart >= 0 ? bodyText.slice(signatureStart, quoteStart) : null,
    quoted: quoteLine >= 0 ? bodyText.slice(quoteStart) : null,
  };
}
