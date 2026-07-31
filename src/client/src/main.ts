/**
 * Entry point for the instant-path bundle (docs/adr/0003).
 *
 * This module is what index.html loads before Blazor boots, so everything reachable from here
 * lands in the critical shell. Keep it small -- custom elements, the IndexedDB layer, and the
 * resistance calculator. Anything derived (progression, analytics, coaching) belongs in
 * TotalGymLogBook.Domain and arrives when the runtime does.
 */

// Registering the custom elements is the point of importing this module -- index.html loads
// it as a side effect, and <tg-app-shell> upgrades as soon as it evaluates.
import './shell/app-shell.js';
import { installBridge } from './db/bridge.js';
import { captureInstallPrompt, requestPersistence } from './storage.js';

// Publish the read-only data bridge before Blazor.start() runs, so [JSImport] can resolve it
// the moment the runtime comes up (docs/adr/0003).
installBridge();

// The browser fires beforeinstallprompt exactly once and early; missing it means never being
// able to offer installation, which is the ONLY eviction protection available on iOS
// (docs/adr/0001). Must be registered before anything else awaits.
captureInstallPrompt();

// Ask to be exempt from eviction. Chromium usually grants this silently for an engaged site;
// elsewhere it is a no-op. Fire-and-forget -- nothing depends on the answer.
void requestPersistence();

export { AppShell } from './shell/app-shell.js';

export * as db from './db/repository.js';
export { exportBackup, exportBackupJson, importBackup, clearAllData } from './db/backup.js';
export { onChange, type ChangeEvent } from './db/events.js';
export { GLOBAL_NAME as DB_BRIDGE_GLOBAL, installBridge } from './db/bridge.js';
export * as storage from './storage.js';

// These must be NAMED EXPORTS of the bundle entry point, because Blazor reaches them via
// JSHost.ImportAsync("tglb-db", "dist/shell.js") and then [JSImport("<name>", "tglb-db")].
// JSImport resolves against the imported module's exports; publishing on globalThis is only a
// console-debugging convenience. See docs/adr/0003.
export {
  getActiveSessionJson,
  getBodyweightReadingsJson,
  getExerciseHistoryJson,
  getHistoriesJson,
  getRecentSetsJson,
  getSessionSetsJson,
  getSettingsJson,
  listMachinesJson,
  listSessionsJson,
  subscribeToChanges,
} from './db/bridge.js';
export type {
  BodyweightRecord,
  MachineRecord,
  SessionRecord,
  SetLogRecord,
  SettingsRecord,
} from './db/schema.js';

export {
  FORMULA_VERSION,
  OUTPUT_DECIMALS,
  PULLEY_FACTOR_CABLE,
  PULLEY_FACTOR_DIRECT,
  addedWeightEfficiency,
  angleForLevel,
  computeResistance,
  computeResistanceRounded,
  type AngleSource,
  type RailProfile,
  type ResistanceInputs,
} from './resistance.js';

export { RailProfileTable } from './profiles.js';
