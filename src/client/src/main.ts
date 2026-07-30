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

export { AppShell } from './shell/app-shell.js';

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
