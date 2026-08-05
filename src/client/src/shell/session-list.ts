/**
 * <tg-session-list>
 *
 * Today's logged sets, newest first, with one-tap correction and delete.
 *
 * Correction matters more than it looks: automatic rep counting will eventually be wrong
 * (docs/adr/0006), and a mistyped rep count that cannot be fixed corrupts the progression data
 * everything else depends on. Delete is a soft delete -- the tombstone survives for a future
 * sync peer (docs/adr/0001).
 */

import * as db from '../db/repository.js';
import type { ExerciseCatalog } from '../exercises.js';
import { setWeight } from '../programs.js';
import { onChange } from '../db/events.js';
import type { SetLogRecord } from '../db/schema.js';

import { ios } from './theme.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; margin-top: .5rem; }
  h3 {
    font-size: var(--text-footnote); font-weight: 400; letter-spacing: .04em;
    text-transform: uppercase; color: var(--muted);
    margin: 1.5rem var(--gutter) .4rem;
  }
  /* The list IS the card -- rows on white, hairlines between, nothing around the outside. */
  ol {
    list-style: none; margin: 0; padding: 0 var(--gutter);
    background: var(--surface); border-radius: var(--radius-card);
  }
  li {
    display: flex; align-items: center; gap: .6rem;
    min-height: var(--tap); padding: .35rem 0;
    border-top: var(--hairline) solid var(--separator);
  }
  li:first-child { border-top: 0; }
  .name { flex: 1; font-size: var(--text-body); }
  .detail { color: var(--muted); font-size: var(--text-footnote); }
  .reps {
    font-variant-numeric: tabular-nums; font-weight: 600; font-size: var(--text-body);
    min-width: 2.2rem; text-align: right;
  }
  .lb { color: var(--muted); font-size: var(--text-subhead); min-width: 3.4rem;
        text-align: right; font-variant-numeric: tabular-nums; }
  button {
    flex: 0 0 auto; min-width: 2rem; min-height: 2rem; padding: 0 .5rem;
    border: 0; border-radius: var(--radius-small);
    background: var(--fill); color: var(--accent);
    font-size: var(--text-subhead);
  }
  /* Deleting is destructive, and iOS never lets that share a color with anything else. */
  button.delete { color: var(--danger); }
  .empty { color: var(--muted); font-size: var(--text-subhead);
           background: var(--surface); border-radius: var(--radius-card);
           padding: .85rem var(--gutter); margin: 0; }
  .total { color: var(--muted); font-size: var(--text-footnote);
           margin: .5rem var(--gutter) 0; }
`);

export class SessionList extends HTMLElement {
  #root: ShadowRoot;
  #catalog?: ExerciseCatalog;
  #sessionId: string | undefined;
  #unsubscribe?: () => void;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [ios, styles];
  }

  configure(opts: { catalog: ExerciseCatalog; sessionId?: string }): void {
    this.#catalog = opts.catalog;
    this.#sessionId = opts.sessionId;
    void this.refresh();
  }

  connectedCallback(): void {
    // Same bus Blazor listens on, so another tab's writes show up here too (docs/adr/0005).
    this.#unsubscribe = onChange((e) => {
      if (e.store === 'setLogs') void this.refresh();
    });
  }

  disconnectedCallback(): void {
    this.#unsubscribe?.();
  }

  async refresh(): Promise<void> {
    if (!this.#sessionId || !this.#catalog) return;

    const sets = (await db.getSessionSets(this.#sessionId)).reverse();
    const catalog = this.#catalog;

    if (sets.length === 0) {
      this.#root.innerHTML = `<h3>This session</h3><p class="empty">No sets yet.</p>`;
      return;
    }

    this.#root.innerHTML = `
      <h3>This session</h3>
      <ol>
        ${sets.map((s) => this.#row(s, catalog)).join('')}
      </ol>
      <p class="total">${sets.length} set${sets.length === 1 ? '' : 's'} &middot;
        <span id="session-muscles">${this.#muscleSummary(sets, catalog)}</span></p>
    `;

    for (const set of sets) {
      this.#root
        .getElementById(`edit-${set.id}`)
        ?.addEventListener('click', () => void this.#edit(set));
      this.#root
        .getElementById(`del-${set.id}`)
        ?.addEventListener('click', () => void this.#delete(set));
    }
  }

  /**
   * What the session actually trained, per muscle.
   *
   * This replaced "12,480 lb total volume", which was a number nobody can act on. Tonnage across
   * different exercises is not comparable in any useful way -- a heavy calf raise outweighs
   * every set of curls you will ever do -- so the total moved with exercise selection more than
   * with effort, and a session could look bigger for being easier.
   *
   * Sets per muscle is the unit the rest of the app already programs and coaches in
   * (docs/adr/0010), which also means the number here and the number the coach quotes are the
   * same number.
   */
  #muscleSummary(sets: readonly SetLogRecord[], catalog: ExerciseCatalog): string {
    const perMuscle = new Map<string, number>();

    for (const set of sets) {
      const exercise = catalog.tryGet(set.exerciseId);
      if (!exercise || exercise.kind !== 'strength') continue;

      // Halved for one-limb work, because the figure this line quotes is per side -- see
      // setWeight. Six single-leg squat sets is three for each quad, and saying six here while
      // the coach says three would make one of them wrong.
      const weight = setWeight(exercise);

      for (const involvement of exercise.muscles) {
        perMuscle.set(
          involvement.muscle,
          (perMuscle.get(involvement.muscle) ?? 0) + involvement.fraction * weight,
        );
      }
    }

    if (perMuscle.size === 0) return 'no working sets yet';

    // Biggest first, and only the ones that got real work. A tail of half-sets is noise on a
    // line that has to be readable at a glance between sets.
    return [...perMuscle]
      .filter(([, count]) => count >= 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([muscle, count]) => `${muscle.toLowerCase()} ${count % 1 === 0 ? count : count.toFixed(1)}`)
      .join(', ');
  }

  #row(set: SetLogRecord, catalog: ExerciseCatalog): string {
    const name = catalog.tryGet(set.exerciseId)?.name ?? set.exerciseId;
    const added = set.vestLb + set.barLb;

    return `
      <li>
        <div class="name">
          ${name}
          <div class="detail">
            Level ${set.level}${added > 0 ? ` &middot; +${added} lb` : ''}${
              set.side ? ` &middot; ${set.side}` : ''
            }
          </div>
        </div>
        <div class="reps">${set.reps}</div>
        <div class="lb">${set.computedLb.toFixed(1)}</div>
        <button id="edit-${set.id}" aria-label="Edit reps">edit</button>
        <button class="delete" id="del-${set.id}" aria-label="Delete set">&times;</button>
      </li>
    `;
  }

  async #edit(set: SetLogRecord): Promise<void> {
    const entered = prompt(`Reps for this set:`, String(set.reps));
    if (entered === null) return;

    const reps = Number(entered);
    if (!Number.isFinite(reps) || reps < 1) return;

    await db.updateSet(set.id, { reps });
    // No manual refresh: the change event brings us back through onChange.
  }

  async #delete(set: SetLogRecord): Promise<void> {
    await db.deleteSet(set.id);
  }
}

customElements.define('tg-session-list', SessionList);
