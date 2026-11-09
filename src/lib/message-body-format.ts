/** Quoted reply line: up to three spaces of indent, then ">". */
const QUOTE_LINE = /^ {0,3}>/;

/**
 * Decides whether a plain-text message body keeps the monospace face.
 *
 * Prose reads in the proportional UI face. Prose that depends on column
 * alignment (indented blocks, code, ASCII tables) loses its meaning there, so
 * it falls back to the raw monospace rendering. Quoted lines (`>`) are the
 * reply chain, not the author's layout: they never force monospace and are not
 * counted for the indented-run or pipe-table tests, and a quoted line breaks an
 * indented run. The test is deterministic and looks only at line shapes; the
 * body is never rewritten and `>` stays.
 */
export function bodyNeedsMonospace(bodyText: string): boolean {
  const lines = bodyText.split('\n');
  let indentedRun = 0;
  let pipeLines = 0;
  for (const line of lines) {
    if (QUOTE_LINE.test(line)) {
      indentedRun = 0;
      continue;
    }
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

/**
 * End of a word for the `u` flag. JS `\b` is ASCII-only (it sees "é" as a
 * non-word character), so words that end in a letter are closed by a
 * Unicode-aware lookahead instead.
 */
const WORD_END = String.raw`(?![\p{L}\p{N}_])`;
/**
 * One attribution ("who wrote this") as a single line, after wrapped lines are
 * joined with a space. `\s` already covers the no-break spaces (U+00A0,
 * U+202F) that French puts before the colon. The leading keyword is anchored at
 * the start and followed by `\s`, so a longer word ("Leon", "Online") never
 * matches.
 * English: On … wrote:   French: Le … a écrit :   German: Am … schrieb …:
 * Spanish: El … escribió:   Italian: Il … ha scritto: (also "Il giorno …")
 * Portuguese: Em … escreveu:   Dutch: Op … schreef …:
 */
const ATTRIBUTION = new RegExp(
  '^(?:'
  + `On\\s.+\\swrote${WORD_END}\\s*:`
  + `|Le\\s.+\\sa\\s+écrit${WORD_END}\\s*:`
  + `|Am\\s.+\\sschrieb${WORD_END}(?:\\s.*)?:`
  + `|El\\s.+\\sescribió${WORD_END}\\s*:`
  + `|Il\\s.+\\sha\\s+scritto${WORD_END}\\s*:`
  + `|Em\\s.+\\sescreveu${WORD_END}\\s*:`
  + `|Op\\s.+\\sschreef${WORD_END}(?:\\s.*)?:`
  + ')$',
  'iu',
);
/** "-----Original Message-----" and its localized forms. */
const ORIGINAL_MESSAGE = new RegExp(
  '^-{2,}\\s*(?:Original Message|Message d[\'\u2019]origine|Ursprüngliche Nachricht|Mensaje original'
  + '|Messaggio originale|Mensagem original|Oorspronkelijk bericht)\\s*-{2,}$',
  'iu',
);
/** An attribution may wrap onto this many lines, and is at most this long once joined. */
const MAX_ATTRIBUTION_LINES = 3;
const MAX_ATTRIBUTION_LENGTH = 300;
/** Exactly the RFC 3676 delimiter: dash, dash, space. A bare "--" is ordinary prose (dimming real content would misrepresent it). */
const SIGNATURE_DELIMITER = /^-- $/;
const MAX_SIGNATURE_LINES = 12;

/**
 * Splits a plain-text body into prose, an optional signature and an optional
 * trailing quote. Deterministic and lossless: the parts are contiguous slices,
 * so `main + (signature ?? '') + (quoted ?? '')` is always the exact original
 * text, line breaks included. Nothing is rewritten, and `>` characters stay.
 *
 * - Trailing quote: an attribution (English, French, German, Spanish, Italian,
 *   Portuguese or Dutch, e.g. "On … wrote:", "Le … a écrit :", "Am … schrieb …:";
 *   it may wrap onto up to three lines and is at most 300 characters when
 *   joined; or a "-----Original Message-----" separator in those languages)
 *   followed by blank lines and a contiguous run of `>` lines that reaches the
 *   end of the body, or a bare run of at least two `>` lines that reaches the
 *   end. The run that reaches the end is the safety net: prose that merely
 *   contains "wrote:" or "schrieb" is never split off. Quotes in the middle of
 *   a body are never split off.
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

  /** First line of the attribution that ends on line `last`, or -1. */
  const attributionStart = (last: number): number => {
    if (ORIGINAL_MESSAGE.test(text(last))) return last;
    const parts: string[] = [];
    for (let first = last; first >= 0 && last - first < MAX_ATTRIBUTION_LINES && !blank(first); first -= 1) {
      parts.unshift(text(first).trim());
      const joined = parts.join(' ');
      if (joined.length > MAX_ATTRIBUTION_LENGTH) return -1;
      if (ATTRIBUTION.test(joined)) return first;
    }
    return -1;
  };

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
    const attribution = before >= 0 ? attributionStart(before) : -1;
    if (attribution >= 0) quoteLine = attribution;
    else if (lastContent - runStart + 1 >= 2) quoteLine = runStart;
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
