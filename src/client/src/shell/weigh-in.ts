/**
 * <tg-weigh-in>
 *
 * Records today's weight and shows what the app can do with what it has so far.
 *
 * This is what makes the coaching in docs/adr/0010 reachable. Phase is inferred from the scale
 * rather than asked, so without repeat weigh-ins the coach stays permanently neutral: no
 * bodyweight compensation, no expectation-setting, nothing. The honest framing -- "a current
 * weight keeps your load numbers accurate" -- is also true, since bodyweight is an input to
 * every resistance figure.
 */

import * as db from '../db/repository.js';
import { onChange } from '../db/events.js';
import { toIsoDate } from '../db/schema.js';
import { describeCoverage, smoothedLb, toReadings } from '../bodyweight.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: .75rem; padding: .85rem 1rem; margin-bottom: .75rem;
  }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; }
  .now { font-size: 1.35rem; font-weight: 650; font-variant-numeric: tabular-nums; }
  .now small { font-size: .8rem; font-weight: 400; color: var(--muted); margin-left: .2rem; }
  .smoothed { color: var(--muted); font-size: .75rem; }
  .note { color: var(--muted); font-size: .75rem; margin: .4rem 0 0; line-height: 1.4; }
  .note.warn { color: #b45309; }
  form { display: flex; gap: .5rem; margin-top: .7rem; }
  input {
    flex: 1; padding: .5rem; font: inherit; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  }
  button {
    font: inherit; font-weight: 600; padding: .5rem .9rem; border: 0; border-radius: .5rem;
    background: var(--accent); color: #fff; cursor: pointer;
  }
  button.link {
    background: transparent; color: var(--muted); font-weight: 400; padding: 0;
    font-size: .75rem; text-decoration: underline; margin-top: .5rem;
  }
  form[hidden] { display: none; }
`);

export class WeighIn extends HTMLElement {
  #root: ShadowRoot;
  #unsubscribe?: () => void;
  #expanded = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
  }

  connectedCallback(): void {
    this.#unsubscribe = onChange((e) => {
      if (e.store === 'bodyweight') void this.refresh();
    });
    void this.refresh();
  }

  disconnectedCallback(): void {
    this.#unsubscribe?.();
  }

  async refresh(): Promise<void> {
    const today = toIsoDate(Date.now());
    const readings = toReadings(await db.getBodyweightReadings());
    const latest = readings[readings.length - 1];
    const smoothed = smoothedLb(readings);
    const coverage = describeCoverage(readings, today);

    // Open by default when there is nothing recorded today, so the common case is one tap.
    const weighedToday = latest?.on === today;
    const open = this.#expanded || !weighedToday;

    this.#root.innerHTML = `
      <div class="card">
        <div class="head">
          <div class="now">
            ${latest ? latest.lb.toFixed(1) : '—'}<small>lb</small>
          </div>
          ${
            smoothed !== undefined && latest && Math.abs(smoothed - latest.lb) >= 0.1
              ? `<div class="smoothed">trend ${smoothed.toFixed(1)} lb</div>`
              : ''
          }
        </div>

        <p class="note${/days ago/.test(coverage) ? ' warn' : ''}" id="coverage">${coverage}</p>

        <form id="form"${open ? '' : ' hidden'}>
          <input type="number" id="lb" min="50" max="500" step="0.1"
                 placeholder="Today's weight"
                 value="${latest ? latest.lb.toFixed(1) : ''}" />
          <button type="submit">Save</button>
        </form>

        ${open ? '' : '<button class="link" id="toggle">Update weight</button>'}
      </div>
    `;

    this.#root.getElementById('toggle')?.addEventListener('click', () => {
      this.#expanded = true;
      void this.refresh();
    });

    this.#root.getElementById('form')?.addEventListener('submit', async (event) => {
      event.preventDefault();

      const lb = Number((this.#root.getElementById('lb') as HTMLInputElement).value);
      if (!Number.isFinite(lb) || lb <= 0) return;

      // One row per calendar day: a re-weigh replaces rather than accumulating, so the EMA is
      // not skewed by someone stepping on the scale three times before breakfast.
      await db.recordBodyweight(today, lb);
      this.#expanded = false;

      this.dispatchEvent(
        new CustomEvent('weighed-in', { bubbles: true, composed: true, detail: { lb } }),
      );
    });
  }
}

customElements.define('tg-weigh-in', WeighIn);
