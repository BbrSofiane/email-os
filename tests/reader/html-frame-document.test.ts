import { describe, expect, it } from 'vitest';
import { buildFrameDocument, fitZoom, frameCsp, FRAME_SANDBOX, type FrameTheme } from '../../src/lib/html-mail/frame-document';
import type { SanitizedMail } from '../../src/lib/html-mail/sanitize';

const mail: SanitizedMail = { styles: '', body: '<p>Mail</p>', remoteBlocked: 0, cidReferences: [], hasOwnColours: false, hasTrailingQuote: false };
const theme: FrameTheme = { mode: 'adaptive', fontFamily: 'sans-serif', fontSize: '15px', lineHeight: '24px', textColour: '#ffffff', linkColour: '#bba5ed' };

describe('frame document', () => {
  it('sets the sandbox and exact policies', () => {
    expect(FRAME_SANDBOX).toBe('allow-same-origin');
    expect(frameCsp(false)).toBe("default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'");
    expect(frameCsp(true)).toBe("default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; form-action 'none'");
  });
  it('places CSP before content and sets theme and quote markers', () => {
    const doc = buildFrameDocument(mail, { remoteImages: false, theme, quoteOpen: true });
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<style>'));
    expect(doc.indexOf('<style>')).toBeLessThan(doc.indexOf('<body>'));
    expect(doc).toContain('eos-quote-open');
    expect(doc).toContain('color-scheme: dark');
    const paper = buildFrameDocument(mail, { remoteImages: false, theme: { ...theme, mode: 'paper' }, quoteOpen: false });
    expect(paper).toContain('color-scheme: light');
    expect(paper).toContain('background: #ffffff');
    expect(paper).toContain('class=""');
  });
  it.each(['fontFamily', 'fontSize', 'lineHeight', 'textColour', 'linkColour'] as const)('rejects CSS injection in %s', (field) => {
    const doc = buildFrameDocument(mail, { remoteImages: false, theme: { ...theme, [field]: 'red; } body { background: url(https://x.invalid) }' }, quoteOpen: false });
    expect(doc).not.toContain('x.invalid');
  });
  it('accepts unitless line height', () => {
    const doc = buildFrameDocument(mail, { remoteImages: false, theme: { ...theme, lineHeight: '1.6' }, quoteOpen: false });
    expect(doc).toContain('line-height: 1.6;');
  });
  it('fits with a floor', () => {
    expect(fitZoom(300, 360)).toBe(1);
    expect(fitZoom(600, 360)).toBe(0.6);
    expect(fitZoom(2000, 360)).toBe(0.5);
  });
});
