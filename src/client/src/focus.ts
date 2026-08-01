/**
 * What the trainee is about to do.
 *
 * The coach used to advise on a hardcoded exercise, which made it useless the moment anyone
 * trained anything else: it would tell you to move up a notch on chest press while you were
 * standing at the squat stand.
 *
 * The fix needs no program and no prediction. The trainee has ALREADY told the app which
 * exercise is next -- they picked it in the set logger, before the first rep. This module is
 * that selection, published so the derived tier can read it.
 *
 * Deliberately not persisted. It is in-flight UI state, not a fact about training history
 * (docs/adr/0005), and writing it to IndexedDB on every dropdown change would put UI churn
 * into a log designed to sync.
 *
 * Deliberately not broadcast to other tabs either. A second tab's dropdown is not this
 * trainee's next set.
 */

export interface Focus {
  /** The exercise selected in the logger, or '' before the shell has configured itself. */
  exerciseId: string;
}

let current: Focus = { exerciseId: '' };

const listeners = new Set<() => void>();

export function getFocus(): Focus {
  return current;
}

export function setFocus(focus: Focus): void {
  if (focus.exerciseId === current.exerciseId) return;

  current = { ...focus };
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      // Same contract as the database bus: one bad subscriber cannot break the others.
      console.error('focus listener threw', error);
    }
  }
}

export function onFocusChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook. */
export function resetFocus(): void {
  listeners.clear();
  current = { exerciseId: '' };
}
