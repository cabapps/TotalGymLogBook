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
import { onChange } from '../db/events.js';
import type { SetLogRecord } from '../db/schema.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; }
  h3 { font-size: .8125rem; color: var(--muted); font-weight: 500; margin: 1.25rem 0 .5rem; }
  ol { list-style: none; margin: 0; padding: 0; }
  li {
    display: flex; align-items: center; gap: .6rem;
    padding: .55rem .25rem; border-bottom: 1px solid var(--border);
  }
  .name { flex: 1; font-size: .875rem; }
  .detail { color: var(--muted); font-size: .75rem; }
  .reps {
    font-variant-numeric: tabular-nums; font-weight: 600; font-size: .95rem;
    min-width: 2.6rem; text-align: right;
  }
  .lb { color: var(--muted); font-size: .8125rem; min-width: 3.6rem; text-align: right;
        font-variant-numeric: tabular-nums; }
  button {
    font: inherit; font-size: .75rem; padding: .2rem .45rem; border-radius: .35rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--muted); cursor: pointer;
  }
  button:hover { color: var(--fg); border-color: var(--accent); }
  .empty { color: var(--muted); font-size: .8125rem; padding: .5rem .25rem; }
  .total { color: var(--muted); font-size: .75rem; margin-top: .5rem; }
`);

export class SessionList extends HTMLElement {
  #root: ShadowRoot;
  #catalog?: ExerciseCatalog;
  #sessionId: string | undefined;
  #unsubscribe?: () => void;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
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

    const volume = sets.reduce((sum, s) => sum + s.computedLb * s.reps, 0);

    this.#root.innerHTML = `
      <h3>This session</h3>
      <ol>
        ${sets.map((s) => this.#row(s, catalog)).join('')}
      </ol>
      <p class="total">${sets.length} sets &middot; ${Math.round(volume).toLocaleString()} lb total volume</p>
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

  #row(set: SetLogRecord, catalog: ExerciseCatalog): string {
    const name = catalog.tryGet(set.exerciseId)?.name ?? set.exerciseId;
    const added = set.vestLb + set.barLb;

    return `
      <li>
        <div class="name">
          ${name}
          <div class="detail">
            Level ${set.level}${added > 0 ? ` &middot; +${added} lb` : ''}
          </div>
        </div>
        <div class="reps">${set.reps}</div>
        <div class="lb">${set.computedLb.toFixed(1)}</div>
        <button id="edit-${set.id}" aria-label="Edit reps">edit</button>
        <button id="del-${set.id}" aria-label="Delete set">&times;</button>
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
