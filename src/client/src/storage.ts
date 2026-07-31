/**
 * Storage durability.
 *
 * With no server, IndexedDB IS the system of record (docs/adr/0001), which makes browser
 * storage eviction the single biggest way a user loses everything. That ADR lists three
 * mitigations; this module implements all three:
 *
 *   1. Add to Home Screen. Safari clears script-writable storage after 7 days without
 *      interaction, and an INSTALLED home-screen PWA is exempt. On iOS this is the only
 *      protection available -- there is no persistence API to ask.
 *   2. navigator.storage.persist(), which exempts the origin from eviction on Chromium.
 *   3. Export, treated as a first-class flow rather than a settings-page afterthought.
 *
 * Every capability here is optional and absent somewhere, so all of it degrades quietly.
 */

export interface StorageStatus {
  /** True when the origin is exempt from eviction. Always false where the API is absent. */
  persisted: boolean;
  /** True when the API exists at all -- distinguishes "denied" from "cannot ask". */
  canRequestPersistence: boolean;
  /** Running as an installed PWA rather than a browser tab. */
  installed: boolean;
  /** An install prompt is available to fire right now (Chromium only). */
  installable: boolean;
  /** iOS cannot prompt; the user has to use the Share sheet. */
  needsManualInstall: boolean;
  usageBytes?: number;
  quotaBytes?: number;
}

let deferredPrompt: BeforeInstallPromptEvent | undefined;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Must run early -- the browser fires this once, and not catching it means never being able to
 * show an install button. Called from main.ts during shell boot.
 */
export function captureInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Suppress the browser's own banner so the app can ask at a moment that makes sense.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    window.dispatchEvent(new CustomEvent('tg-installable'));
  });

  window.addEventListener('appinstalled', () => {
    deferredPrompt = undefined;
    window.dispatchEvent(new CustomEvent('tg-installed'));
  });
}

export function isInstalled(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    // iOS predates the display-mode media query for home-screen apps.
    (navigator as { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ reports as a Mac; the touch points give it away.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function isInstallable(): boolean {
  return deferredPrompt !== undefined;
}

/** Fires the browser's install prompt. Must be called from a user gesture. */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt) return 'unavailable';

  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = undefined;
  return outcome;
}

/**
 * Asks the browser to exempt this origin from storage eviction.
 *
 * Chromium usually grants this silently once the site looks "engaged" (bookmarked, installed,
 * high engagement score). Firefox prompts. Safari has no such API at all -- there, installing
 * to the home screen is the whole story.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function getStatus(): Promise<StorageStatus> {
  const canRequestPersistence = Boolean(navigator.storage?.persist);
  const persisted = canRequestPersistence ? await navigator.storage.persisted() : false;
  const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : undefined;

  const installed = isInstalled();

  return {
    persisted,
    canRequestPersistence,
    installed,
    installable: isInstallable(),
    needsManualInstall: !installed && isIos(),
    ...(estimate?.usage !== undefined && { usageBytes: estimate.usage }),
    ...(estimate?.quota !== undefined && { quotaBytes: estimate.quota }),
  };
}

/**
 * Plain-language risk summary. Deliberately concrete about consequences -- "your log could be
 * cleared" is the honest framing, and it is why installing is worth a tap.
 */
export function describeRisk(status: StorageStatus): { level: 'ok' | 'warn'; text: string } {
  if (status.installed) {
    return {
      level: 'ok',
      text: 'Installed to your home screen, so your logbook is safe from browser cleanup.',
    };
  }

  if (status.persisted) {
    return { level: 'ok', text: 'Your browser has marked this data as protected.' };
  }

  if (status.needsManualInstall) {
    return {
      level: 'warn',
      text:
        'Safari can clear this data if you go a week without opening the app. Add it to your '
        + 'home screen (Share, then Add to Home Screen) and it stops doing that.',
    };
  }

  return {
    level: 'warn',
    text: 'Your browser may clear this data if it runs short on space. Installing the app, or '
      + 'exporting a backup, protects your logbook.',
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Triggers a file download without a server round-trip. */
export function downloadFile(filename: string, contents: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function backupFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `totalgymlogbook-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}
