import { describe, expect, it } from 'vitest';
import { linkHostMismatch, mailtoAddress } from '../../src/lib/external-links';

describe('external links', () => {
  it('compares visible hosts without www or case', () => {
    expect(linkHostMismatch('https://www.example.test/path', 'EXAMPLE.test')).toBe(false);
    expect(linkHostMismatch('https://example.test', 'other.test')).toBe(true);
    expect(linkHostMismatch('https://example.test', 'Read more')).toBe(false);
    expect(linkHostMismatch('mailto:a@example.test', 'other.test')).toBe(false);
  });
  it('extracts only the first valid address and ignores parameters', () => {
    expect(mailtoAddress('mailto:attacker@example.test?subject=Urgent&body=Send%20the%20code&cc=boss@example.test')).toBe('attacker@example.test');
    expect(mailtoAddress('mailto:a@b.test,c@d.test')).toBe('a@b.test');
    expect(mailtoAddress('mailto:')).toBeNull();
    expect(mailtoAddress('mailto:%0Aevil@x.test')).toBeNull();
  });
});

describe('link text that only looks like a host', () => {
  it('does not warn for version numbers or abbreviations', () => {
    expect(linkHostMismatch('https://news.example.test/a1', 'v1.2')).toBe(false);
    expect(linkHostMismatch('https://news.example.test/a1', 'e.g.')).toBe(false);
    expect(linkHostMismatch('https://login.bank.invalid/', 'https://www.example.test/account')).toBe(true);
  });
});
