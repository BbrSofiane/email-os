import { beforeEach, describe, expect, it } from 'vitest';
import { loadSwipePreferences, saveSwipePreferences } from '../src/lib/swipe-preferences';

describe('swipe preferences', () => {
  beforeEach(() => localStorage.clear());

  it('uses safe defaults when missing or invalid', () => {
    expect(loadSwipePreferences()).toEqual({ right: 'remind', left: 'done' });
    localStorage.setItem('email-os.swipe-preferences.v1', JSON.stringify({ version: 1, right: 'delete', left: 'done' }));
    expect(loadSwipePreferences()).toEqual({ right: 'remind', left: 'done' });
  });

  it('persists validated choices with a version', () => {
    saveSwipePreferences({ right: 'none', left: 'remind' });
    expect(localStorage.getItem('email-os.swipe-preferences.v1')).toBe('{"version":1,"right":"none","left":"remind"}');
    expect(loadSwipePreferences()).toEqual({ right: 'none', left: 'remind' });
  });
});
