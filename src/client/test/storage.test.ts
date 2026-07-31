/**
 * Storage durability is the difference between "your logbook is safe" and "your logbook is
 * gone" (docs/adr/0001), and every API involved is absent on some platform. These tests are
 * mostly about degrading correctly rather than about happy paths.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  backupFilename,
  describeRisk,
  formatBytes,
  getStatus,
  isInstalled,
  isIos,
  requestPersistence,
  type StorageStatus,
} from '../src/storage.js';

const baseStatus = (over: Partial<StorageStatus> = {}): StorageStatus => ({
  persisted: false,
  canRequestPersistence: true,
  installed: false,
  installable: false,
  needsManualInstall: false,
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('capability detection degrades where APIs are absent', () => {
  it('reports not-persisted rather than throwing when the API is missing', async () => {
    vi.stubGlobal('navigator', { userAgent: 'test', platform: 'Linux', maxTouchPoints: 0 });
    vi.stubGlobal('window', { matchMedia: undefined });

    const status = await getStatus();
    expect(status.persisted).toBe(false);
    expect(status.canRequestPersistence).toBe(false);
  });

  it('distinguishes "denied" from "cannot ask"', async () => {
    // Safari has no persistence API at all, so the UI must not offer a button that does
    // nothing -- canRequestPersistence is what that decision hangs on.
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      platform: 'Linux',
      maxTouchPoints: 0,
      storage: { persist: async () => false, persisted: async () => false },
    });
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });

    const status = await getStatus();
    expect(status.canRequestPersistence).toBe(true);
    expect(status.persisted).toBe(false);
  });

  it('returns false rather than throwing when persist() rejects', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persist: async () => {
          throw new Error('denied');
        },
      },
    });

    await expect(requestPersistence()).resolves.toBe(false);
  });

  it('detects an installed PWA through either signal', async () => {
    vi.stubGlobal('navigator', { userAgent: 'test', platform: 'Linux', maxTouchPoints: 0 });
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
    expect(isInstalled()).toBe(true);

    // iOS predates display-mode for home-screen apps and uses navigator.standalone.
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal('navigator', { standalone: true, userAgent: 'test', platform: 'x' });
    expect(isInstalled()).toBe(true);
  });

  it('detects iPadOS, which reports itself as a Mac', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 });
    expect(isIos()).toBe(true);

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 });
    expect(isIos()).toBe(false);
  });
});

describe('risk messaging', () => {
  it('reassures once installed', () => {
    const risk = describeRisk(baseStatus({ installed: true }));
    expect(risk.level).toBe('ok');
    expect(risk.text).toMatch(/home screen/i);
  });

  it('reassures once persistence is granted', () => {
    expect(describeRisk(baseStatus({ persisted: true })).level).toBe('ok');
  });

  it('gives iOS users the only instructions that work for them', () => {
    // No persistence API on Safari, so Add to Home Screen is the whole mitigation.
    const risk = describeRisk(baseStatus({ needsManualInstall: true }));
    expect(risk.level).toBe('warn');
    expect(risk.text).toMatch(/Share/);
    expect(risk.text).toMatch(/Add to Home Screen/i);
  });

  it('is concrete about the consequence rather than vague', () => {
    // "Your browser may clear this data" is the honest framing and the reason to act.
    const risk = describeRisk(baseStatus());
    expect(risk.level).toBe('warn');
    expect(risk.text).toMatch(/clear this data/i);
  });

  it('never blames the user or uses jargon', () => {
    const jargon = ['IndexedDB', 'origin', 'quota', 'eviction', 'ITP'];
    for (const status of [
      baseStatus(),
      baseStatus({ installed: true }),
      baseStatus({ persisted: true }),
      baseStatus({ needsManualInstall: true }),
    ]) {
      const text = describeRisk(status).text;
      for (const word of jargon) {
        expect(text.toLowerCase()).not.toContain(word.toLowerCase());
      }
    }
  });
});

describe('formatting', () => {
  it('formats byte counts readably', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('names backups by date so they sort and do not collide', () => {
    expect(backupFilename(new Date(2026, 2, 7))).toBe('totalgymlogbook-2026-03-07.json');
    expect(backupFilename(new Date(2026, 11, 25))).toBe('totalgymlogbook-2026-12-25.json');
  });
});
