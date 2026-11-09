import { describe, expect, it } from 'vitest';
import { bodyNeedsMonospace, splitMessageBody } from '../src/lib/message-body-format';

describe('bodyNeedsMonospace', () => {
  it('keeps plain prose proportional', () => {
    expect(bodyNeedsMonospace('Hi,\n\nThe sync fix is on track. Thanks > nothing.\n\nAda')).toBe(false);
    expect(bodyNeedsMonospace('')).toBe(false);
    expect(bodyNeedsMonospace('    one indented line only\nthen prose')).toBe(false);
    expect(bodyNeedsMonospace('a | b\nno second pipe line')).toBe(false);
  });

  it('does not force monospace for quoted lines by themselves', () => {
    expect(bodyNeedsMonospace('Thanks\n\nOn Thu Ada wrote:\n> can we ship?')).toBe(false);
    expect(bodyNeedsMonospace('>quoted without a space')).toBe(false);
    // One interleaved quoted line in otherwise normal prose.
    expect(bodyNeedsMonospace('Hi,\n\n> Are we on for Friday?\n\nYes, we are. Details below.\n\nAda')).toBe(false);
  });

  it('keeps an inline-reply thread (alternating quote and answer) proportional', () => {
    const thread = '> Are we on?\nYes.\n> And Friday?\nAlso yes.\n> Budget?\nApproved, see the note.';
    expect(bodyNeedsMonospace(thread)).toBe(false);
    expect(bodyNeedsMonospace('  > indented marker\nAnswer.\n   > another\nAnswer two.')).toBe(false);
  });

  it('keeps an all-quote body proportional', () => {
    expect(bodyNeedsMonospace('> a\n> b\n> c')).toBe(false);
    expect(bodyNeedsMonospace('> | a | b |\n> | c | d |\n>     code\n>     more')).toBe(false);
  });

  it('ignores quoted pipe and indented lines, but not the same shapes in the prose', () => {
    expect(bodyNeedsMonospace('Reply.\n> | step | owner |\n> | merge | ada |')).toBe(false);
    expect(bodyNeedsMonospace('Reply.\n>     $ pnpm test\n>     ok')).toBe(false);
    // A quoted line breaks an indented run: the two indented lines are not consecutive.
    expect(bodyNeedsMonospace('    a\n> q\n    b')).toBe(false);
    // Prose shapes still win with quotes present.
    expect(bodyNeedsMonospace('> Can you show it?\nSure:\n    $ pnpm test\n    ok\n> thanks')).toBe(true);
    expect(bodyNeedsMonospace('> Status?\n| step | owner |\n> more\n| merge | ada |')).toBe(true);
    // One pipe line in the prose plus a quoted pipe line is not a table.
    expect(bodyNeedsMonospace('| a | b |\n> | c | d |')).toBe(false);
  });

  it('uses monospace for two consecutive indented lines or a tab block', () => {
    expect(bodyNeedsMonospace('Run:\n    $ pnpm test\n    ok')).toBe(true);
    expect(bodyNeedsMonospace('Run:\n\tfoo\n\tbar')).toBe(true);
    expect(bodyNeedsMonospace('    a\nprose\n    b')).toBe(false);
  });

  it('uses monospace for table-ish pipe lines', () => {
    expect(bodyNeedsMonospace('| step | owner |\n| merge | ada |')).toBe(true);
  });
});

describe('splitMessageBody', () => {
  const rejoin = (body: string): string => {
    const parts = splitMessageBody(body);
    return parts.main + (parts.signature ?? '') + (parts.quoted ?? '');
  };

  it('returns the body unchanged when there is no signature or trailing quote', () => {
    const body = 'Hi,\n\nThanks > nothing.\n\nAda';
    expect(splitMessageBody(body)).toEqual({ main: body, signature: null, quoted: null });
    expect(splitMessageBody('')).toEqual({ main: '', signature: null, quoted: null });
  });

  it('splits an attributed trailing quote and keeps the blank line with the prose', () => {
    const body = 'Shipping Friday.\n\nOn Thu, Ada wrote:\n> can we ship?\n> soon\n';
    expect(splitMessageBody(body)).toEqual({
      main: 'Shipping Friday.\n\n',
      signature: null,
      quoted: 'On Thu, Ada wrote:\n> can we ship?\n> soon\n',
    });
  });

  it('accepts a wrapped attribution, blank lines before the quote, and Original Message', () => {
    const wrapped = 'Yes.\nOn Thu, 6 Nov 2026 at 09:00, Ada Fixture <ada@example.test>\nwrote:\n\n> q';
    expect(splitMessageBody(wrapped).quoted).toBe('On Thu, 6 Nov 2026 at 09:00, Ada Fixture <ada@example.test>\nwrote:\n\n> q');
    const original = 'Yes.\n-----Original Message-----\n> q';
    expect(splitMessageBody(original)).toEqual({ main: 'Yes.\n', signature: null, quoted: '-----Original Message-----\n> q' });
  });

  it('splits a bare trailing run of two or more quoted lines but not a single one', () => {
    expect(splitMessageBody('Yes.\n> a\n> b').quoted).toBe('> a\n> b');
    expect(splitMessageBody('Yes.\n> a')).toEqual({ main: 'Yes.\n> a', signature: null, quoted: null });
  });

  it('keeps interleaved quotes in the prose', () => {
    const body = '> Are we on?\nYes.\n> And Friday?\nAlso yes.';
    expect(splitMessageBody(body)).toEqual({ main: body, signature: null, quoted: null });
  });

  it('splits a short RFC 3676 signature after the exact "-- " delimiter', () => {
    expect(splitMessageBody('Thanks.\n-- \nAda\nExample Co')).toEqual({
      main: 'Thanks.\n',
      signature: '-- \nAda\nExample Co',
      quoted: null,
    });
    // CRLF line ends keep the delimiter.
    expect(splitMessageBody('Thanks.\r\n-- \r\nAda').signature).toBe('-- \r\nAda');
  });

  it('never dims real content after a bare "--" line (no trailing space)', () => {
    const body = 'Summary below.\n--\nItem one: ship Friday\nItem two: hire\nItem three: budget\nItem four: legal\nItem five: rent';
    expect(splitMessageBody(body)).toEqual({ main: body, signature: null, quoted: null });
    // Even a short tail: only the standard delimiter marks a signature.
    expect(splitMessageBody('Thanks.\n--\nAda')).toEqual({ main: 'Thanks.\n--\nAda', signature: null, quoted: null });
    // A bare "--" before a real delimiter does not move the signature start.
    const both = 'Intro.\n--\nnot a signature\n-- \nAda';
    expect(splitMessageBody(both).main).toBe('Intro.\n--\nnot a signature\n');
    expect(splitMessageBody(both).signature).toBe('-- \nAda');
  });

  it('keeps the decision about a quoted "-- " line inside prose to the last delimiter', () => {
    const body = 'a\n-- \nb\n-- \nc';
    expect(splitMessageBody(body).signature).toBe('-- \nc');
  });

  it('does not treat a long tail after the delimiter as a signature', () => {
    const tail = Array.from({ length: 13 }, (_, i) => `line ${i}`).join('\n');
    const body = `Intro.\n-- \n${tail}`;
    expect(splitMessageBody(body)).toEqual({ main: body, signature: null, quoted: null });
    const twelve = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    expect(splitMessageBody(`Intro.\n-- \n${twelve}`).signature).toBe(`-- \n${twelve}`);
  });

  it('orders main, signature, quoted and ignores a delimiter inside the quote', () => {
    const body = 'Thanks.\n-- \nAda\n\nOn Thu, Bob wrote:\n> hi\n> -- \n> Bob';
    const parts = splitMessageBody(body);
    expect(parts.main).toBe('Thanks.\n');
    expect(parts.signature).toBe('-- \nAda\n\n');
    expect(parts.quoted).toBe('On Thu, Bob wrote:\n> hi\n> -- \n> Bob');
  });

  it('never hides a body that is entirely quote', () => {
    const quoted = 'On Thu, Ada wrote:\n> can we ship?\n> soon';
    expect(splitMessageBody(quoted)).toEqual({ main: quoted, signature: null, quoted: null });
    const bare = '> a\n> b';
    expect(splitMessageBody(bare)).toEqual({ main: bare, signature: null, quoted: null });
    const sigOnly = '-- \nAda';
    expect(splitMessageBody(sigOnly)).toEqual({ main: sigOnly, signature: null, quoted: null });
  });

  it('is lossless for every shape, including CRLF and hostile markup', () => {
    const bodies = [
      'Hi\r\n\r\nOn Thu, Ada wrote:\r\n> <img src=x onerror=alert(1)>\r\n> more\r\n',
      'a\n-- \nsig\nOn x wrote:\n> q',
      'a\n\n\n> x\n> y\n\n\n',
      '<b>bold</b>\n--\n<script>1</script>',
      'only prose',
    ];
    for (const body of bodies) expect(rejoin(body)).toBe(body);
  });

  it('evaluates monospace on the prose part only', () => {
    const aligned = 'Run:\n    $ pnpm test\n    ok\n\nOn Thu, Ada wrote:\n> a\n> b';
    expect(bodyNeedsMonospace(splitMessageBody(aligned).main)).toBe(true);
    const quotedTable = 'Short prose reply.\n\nOn Thu, Ada wrote:\n> | a | b |\n> | c | d |';
    expect(bodyNeedsMonospace(quotedTable)).toBe(false);
    expect(bodyNeedsMonospace(splitMessageBody(quotedTable).main)).toBe(false);
  });

  describe('localized attributions', () => {
    const NBSP = '\u00a0';
    const cases: Array<[string, string]> = [
      ['English', 'On Thu, 6 Nov 2026 at 09:00, Ada <ada@example.test> wrote:'],
      ['French', 'Le jeudi 6 novembre 2026 à 09:00, Ada <ada@example.test> a écrit :'],
      ['French without a space before the colon', 'Le 6 nov. 2026, Ada a écrit:'],
      ['French with a no-break space', `Le 6 nov. 2026 à 09:00, Ada <ada@example.test> a écrit${NBSP}:`],
      ['French with a narrow no-break space', 'Le 6 nov. 2026, Ada a écrit\u202f:'],
      ['German', 'Am 06.11.2026 um 09:00 schrieb Ada Fixture <ada@example.test>:'],
      ['German, no address', 'Am 06.11.2026 schrieb Ada:'],
      ['Spanish', 'El jue, 6 nov 2026 a las 9:00, Ada <ada@example.test> escribió:'],
      ['Italian', 'Il 06/11/2026 09:00 Ada <ada@example.test> ha scritto:'],
      ['Italian (Il giorno)', 'Il giorno gio 6 nov 2026 alle ore 09:00 Ada <ada@example.test> ha scritto:'],
      ['Portuguese', 'Em qui., 6 de nov. de 2026 às 09:00, Ada <ada@example.test> escreveu:'],
      ['Dutch', 'Op 6 nov. 2026 om 09:00 schreef Ada <ada@example.test>:'],
      ['French Original Message', "-----Message d'origine-----"],
      ['French Original Message (typographic apostrophe)', '-----Message d’origine-----'],
      ['German Original Message', '-----Ursprüngliche Nachricht-----'],
      ['Spanish Original Message', '-----Mensaje original-----'],
      ['Italian Original Message', '-----Messaggio originale-----'],
      ['Portuguese Original Message', '-----Mensagem original-----'],
      ['Dutch Original Message', '-----Oorspronkelijk bericht-----'],
    ];

    it.each(cases)('collapses a trailing quote after a %s attribution', (_name, attribution) => {
      const body = `Merci, c’est bon.\n\n${attribution}\n> Peut-on livrer ?\n> Vendredi.\n`;
      const parts = splitMessageBody(body);
      expect(parts.main).toBe('Merci, c’est bon.\n\n');
      expect(parts.signature).toBeNull();
      expect(parts.quoted).toBe(`${attribution}\n> Peut-on livrer ?\n> Vendredi.\n`);
      expect(rejoin(body)).toBe(body);
    });

    it.each(cases)('collapses a %s attribution with blank lines before the quote and CRLF line ends', (_name, attribution) => {
      const body = `Ok.\r\n\r\n${attribution}\r\n\r\n> q\r\n`;
      const parts = splitMessageBody(body);
      expect(parts.main).toBe('Ok.\r\n\r\n');
      expect(parts.quoted).toBe(`${attribution}\r\n\r\n> q\r\n`);
      expect(rejoin(body)).toBe(body);
    });

    it('accepts an attribution wrapped onto two or three lines', () => {
      const german = 'Danke.\nAm 06.11.2026 um 09:00 schrieb Ada Fixture\n<ada@example.test>:\n> Passt?';
      expect(splitMessageBody(german)).toEqual({
        main: 'Danke.\n',
        signature: null,
        quoted: 'Am 06.11.2026 um 09:00 schrieb Ada Fixture\n<ada@example.test>:\n> Passt?',
      });
      const french = 'Merci.\nLe jeudi 6 novembre 2026 à 09:00, Ada Fixture\n<ada@example.test>\na écrit :\n\n> Ok ?';
      expect(splitMessageBody(french).main).toBe('Merci.\n');
      expect(splitMessageBody(french).quoted).toBe('Le jeudi 6 novembre 2026 à 09:00, Ada Fixture\n<ada@example.test>\na écrit :\n\n> Ok ?');
      const dutch = 'Prima.\nOp 6 nov. 2026 om 09:00 schreef\nAda\n<ada@example.test>:\n> Klaar?';
      expect(splitMessageBody(dutch).quoted).toBe('Op 6 nov. 2026 om 09:00 schreef\nAda\n<ada@example.test>:\n> Klaar?');
    });

    it('does not join four wrapped lines or an attribution longer than 300 characters', () => {
      const four = 'Danke.\nAm 06.11.2026\num 09:00\nschrieb Ada\nFixture:\n> Passt?';
      expect(splitMessageBody(four)).toEqual({ main: four, signature: null, quoted: null });
      const longName = 'x'.repeat(300);
      const long = `Danke.\nAm 06.11.2026 schrieb ${longName}:\n> Passt?`;
      expect(splitMessageBody(long)).toEqual({ main: long, signature: null, quoted: null });
      const edge = `Am 06.11.2026 schrieb ${'x'.repeat(300 - 'Am 06.11.2026 schrieb :'.length)}:`;
      expect(edge.length).toBe(300);
      expect(splitMessageBody(`Danke.\n${edge}\n> Passt?`).quoted).toBe(`${edge}\n> Passt?`);
    });

    it('does not join across a blank line', () => {
      const body = 'Danke.\nAm 06.11.2026 um 09:00 schrieb Ada\n\n<ada@example.test>:\n> Passt?';
      // Only "<ada@example.test>:" sits directly above the quote and it is not an attribution.
      expect(splitMessageBody(body)).toEqual({ main: body, signature: null, quoted: null });
    });

    it('treats a bare run of two quoted lines after a non-attribution line as before', () => {
      const body = 'Le résultat est le suivant :\n> a\n> b';
      expect(splitMessageBody(body).main).toBe('Le résultat est le suivant :\n');
      expect(splitMessageBody(body).quoted).toBe('> a\n> b');
    });

    it('never splits prose that only looks like an attribution when no quote run follows', () => {
      for (const body of [
        'Le résultat est le suivant :\n- un\n- deux',
        'Ada a écrit :\nde belles choses.',
        'Le jeudi, Ada a écrit :\nje viens.',
        'Am Montag schrieb Ada:\nIch komme.',
        'He wrote:\nnothing much.\n',
        'Er schrieb gestern, dass es klappt.',
        'Le fichier a été écrit :',
        'El jefe escribió:\n',
      ]) {
        expect(splitMessageBody(body)).toEqual({ main: body, signature: null, quoted: null });
      }
    });

    it('keeps a localized attribution in the middle of the body in the prose', () => {
      const body = 'Am Montag schrieb Ada:\n> Passt es?\nJa, passt.\nGruß';
      expect(splitMessageBody(body)).toEqual({ main: body, signature: null, quoted: null });
      const french = 'Le lundi, Ada a écrit :\n> Ok ?\n> Vraiment ?\nOui, bien sûr.';
      expect(splitMessageBody(french)).toEqual({ main: french, signature: null, quoted: null });
    });

    it('does not read a word that merely starts with a keyword as an attribution', () => {
      for (const body of [
        'Lettre a écrit :\n> q\n> r\nafter',
        'Online schrieb Ada:\n> q\n> r\nafter',
      ]) {
        expect(splitMessageBody(body).quoted).toBeNull();
      }
      // The keyword must be a whole word: "Leon" is not "Le".
      const leon = 'Hi.\nLeon Ada a écrit :\n> q';
      expect(splitMessageBody(leon).quoted).toBeNull();
      // The verb must be a whole word: "schriebt" is not "schrieb".
      const verb = 'Hi.\nAm Montag schriebt Ada:\n> q';
      expect(splitMessageBody(verb).quoted).toBeNull();
    });

    it('splits a signature that comes before a localized attribution', () => {
      const body = 'Merci.\n-- \nAda\nExemple SA\n\nLe jeudi 6 novembre 2026, Bob a écrit :\n> salut\n> -- \n> Bob';
      const parts = splitMessageBody(body);
      expect(parts.main).toBe('Merci.\n');
      expect(parts.signature).toBe('-- \nAda\nExemple SA\n\n');
      expect(parts.quoted).toBe('Le jeudi 6 novembre 2026, Bob a écrit :\n> salut\n> -- \n> Bob');
      const german = 'Danke.\n-- \nAda\n\n-----Ursprüngliche Nachricht-----\n> hallo';
      expect(splitMessageBody(german).signature).toBe('-- \nAda\n\n');
      expect(splitMessageBody(german).quoted).toBe('-----Ursprüngliche Nachricht-----\n> hallo');
    });

    it('never hides a body that is only a localized attribution and quote', () => {
      const body = 'Am 06.11.2026 schrieb Ada:\n> Passt?';
      expect(splitMessageBody(body)).toEqual({ main: body, signature: null, quoted: null });
    });

    it('is lossless over every localized fixture, with and without CRLF', () => {
      for (const [, attribution] of cases) {
        for (const eol of ['\n', '\r\n']) {
          for (const tail of ['', eol, `${eol}${eol}`]) {
            const body = ['Intro.', '', attribution, '> a', '> b'].join(eol) + tail;
            expect(rejoin(body)).toBe(body);
            const sig = ['Intro.', '-- ', 'Ada', '', attribution, '', '> a'].join(eol) + tail;
            expect(rejoin(sig)).toBe(sig);
          }
        }
      }
    });
  });
});
