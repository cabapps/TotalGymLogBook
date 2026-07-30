/**
 * <tg-set-logger>
 *
 * The hot path. Everything here works before the .NET runtime exists, and a tap on "Log set"
 * is durable in IndexedDB before the button's animation finishes (docs/adr/0003, 0005).
 *
 * The load readout is computed locally by the TypeScript mirror of the resistance calculator.
 * That duplication is deliberate: routing it through interop would mean no number until Blazor
 * boots, which defeats the whole split.
 */

import { computeResistance, type RailProfile } from '../resistance.js';
import type { Exercise, ExerciseCatalog } from '../exercises.js';
import * as db from '../db/repository.js';
import { FORMULA_VERSION, PULLEY_FACTOR_CABLE, PULLEY_FACTOR_DIRECT } from '../resistance.js';

/** In-flight UI state. sessionStorage per docs/adr/0005: fast, and gone when the tab closes. */
const UI_KEY = 'tg.logger';

interface UiState {
  exerciseId: string;
  level: number;
  reps: number;
  vestLb: number;
  barLb: number;
}

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: .75rem; padding: 1rem; margin-bottom: .75rem;
  }
  select, input[type=number] {
    width: 100%; padding: .5rem; font: inherit; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  }
  label { display: block; font-size: .75rem; color: var(--muted); margin: .75rem 0 .25rem; }
  .cue { font-size: .75rem; color: var(--muted); margin: .4rem 0 0; line-height: 1.4; }
  .load { display: flex; align-items: baseline; gap: .4rem; margin-top: .85rem; }
  .load b { font-size: 2.25rem; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1; }
  .load span { color: var(--muted); font-size: .8125rem; }
  input[type=range] { width: 100%; accent-color: var(--accent); }
  .stepper { display: flex; align-items: stretch; gap: .5rem; }
  .stepper button {
    flex: 0 0 3rem; font: inherit; font-size: 1.35rem; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg); cursor: pointer;
  }
  .stepper button:active { background: var(--surface); }
  .stepper input { text-align: center; font-size: 1.15rem; font-variant-numeric: tabular-nums; }
  .log {
    width: 100%; margin-top: 1rem; padding: .85rem; font: inherit; font-weight: 600;
    border: 0; border-radius: .65rem; background: var(--accent); color: #fff; cursor: pointer;
  }
  .log:disabled { opacity: .5; cursor: default; }
  .row { display: flex; gap: .75rem; }
  .row > * { flex: 1; }
`);

export class SetLogger extends HTMLElement {
  #root: ShadowRoot;
  #catalog?: ExerciseCatalog;
  #profile?: RailProfile;
  #bodyweightLb = 180;
  #sessionId?: string;
  #state: UiState = { exerciseId: '', level: 8, reps: 10, vestLb: 0, barLb: 0 };

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
  }

  /** Called by the shell once the catalogue and machine are known. */
  configure(opts: {
    catalog: ExerciseCatalog;
    profile: RailProfile;
    bodyweightLb: number;
    sessionId: string;
  }): void {
    this.#catalog = opts.catalog;
    this.#profile = opts.profile;
    this.#bodyweightLb = opts.bodyweightLb;
    this.#sessionId = opts.sessionId;

    this.#state = { ...this.#state, ...this.#restore() };
    if (!this.#catalog.tryGet(this.#state.exerciseId)) {
      this.#state.exerciseId = this.#catalog.all[0]!.id;
    }
    this.#state.level = Math.min(this.#state.level, opts.profile.levelCount);

    this.#render();
  }

  #restore(): Partial<UiState> {
    try {
      return JSON.parse(sessionStorage.getItem(UI_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  #persist(): void {
    sessionStorage.setItem(UI_KEY, JSON.stringify(this.#state));
  }

  get #exercise(): Exercise {
    return this.#catalog!.get(this.#state.exerciseId);
  }

  #computedLb(): number {
    const e = this.#exercise;
    return computeResistance(this.#profile!, {
      bodyweightLb: this.#bodyweightLb,
      level: this.#state.level,
      usesPulley: e.usesPulley,
      bodyFraction: e.bodyFraction,
      vestLb: this.#state.vestLb,
      barLb: this.#state.barLb,
    });
  }

  #render(): void {
    const catalog = this.#catalog!;
    const profile = this.#profile!;
    const s = this.#state;

    this.#root.innerHTML = `
      <div class="card">
        <label for="exercise">Exercise</label>
        <select id="exercise">
          ${catalog.all
            .map(
              (e) =>
                `<option value="${e.id}"${e.id === s.exerciseId ? ' selected' : ''}>${e.name}${
                  e.attachment ? ` (${e.attachment})` : ''
                }</option>`,
            )
            .join('')}
        </select>
        <p class="cue" id="cue"></p>

        <div class="load">
          <b id="load">—</b><span>lb</span><span id="loadNote"></span>
        </div>

        <label for="level">Level <span id="levelText">${s.level}</span></label>
        <input type="range" id="level" min="1" max="${profile.levelCount}" step="1" value="${s.level}" />

        <label for="reps">Reps</label>
        <div class="stepper">
          <button id="minus" aria-label="One fewer rep">&minus;</button>
          <input type="number" id="reps" min="1" max="100" value="${s.reps}" />
          <button id="plus" aria-label="One more rep">+</button>
        </div>

        <div class="row">
          <div>
            <label for="vest">Vest (lb)</label>
            <input type="number" id="vest" min="0" step="2.5" value="${s.vestLb}" />
          </div>
          <div>
            <label for="bar">Bar (lb)</label>
            <input type="number" id="bar" min="0" step="2.5" value="${s.barLb}" />
          </div>
        </div>

        <button class="log" id="log">Log set</button>
      </div>
    `;

    const on = (id: string, event: string, fn: () => void) =>
      this.#root.getElementById(id)!.addEventListener(event, fn);

    on('exercise', 'change', () => {
      s.exerciseId = (this.#root.getElementById('exercise') as HTMLSelectElement).value;
      this.#update();
    });
    on('level', 'input', () => {
      s.level = Number((this.#root.getElementById('level') as HTMLInputElement).value);
      this.#update();
    });
    on('reps', 'input', () => {
      s.reps = Number((this.#root.getElementById('reps') as HTMLInputElement).value) || 1;
      this.#update();
    });
    on('vest', 'input', () => {
      s.vestLb = Number((this.#root.getElementById('vest') as HTMLInputElement).value) || 0;
      this.#update();
    });
    on('bar', 'input', () => {
      s.barLb = Number((this.#root.getElementById('bar') as HTMLInputElement).value) || 0;
      this.#update();
    });
    on('minus', 'click', () => this.#nudgeReps(-1));
    on('plus', 'click', () => this.#nudgeReps(1));
    on('log', 'click', () => void this.#logSet());

    this.#update();
  }

  #nudgeReps(delta: number): void {
    this.#state.reps = Math.max(1, this.#state.reps + delta);
    (this.#root.getElementById('reps') as HTMLInputElement).value = String(this.#state.reps);
    this.#update();
  }

  #update(): void {
    const e = this.#exercise;
    const lb = this.#computedLb();

    this.#root.getElementById('load')!.textContent = lb.toFixed(1);
    this.#root.getElementById('levelText')!.textContent = String(this.#state.level);
    this.#root.getElementById('cue')!.textContent = e.cue;
    this.#root.getElementById('loadNote')!.textContent = e.usesPulley
      ? '· cable, so half the incline load'
      : '';

    this.#persist();
  }

  async #logSet(): Promise<void> {
    const button = this.#root.getElementById('log') as HTMLButtonElement;
    button.disabled = true;

    try {
      const e = this.#exercise;
      const profile = this.#profile!;

      // The full snapshot from docs/adr/0004. Historical resistance is never recomputed, so
      // every input that went into this number is frozen alongside it.
      await db.logSet({
        sessionId: this.#sessionId!,
        exerciseId: e.id,
        reps: this.#state.reps,
        level: this.#state.level,
        bodyweightRawLb: this.#bodyweightLb,
        bodyweightSmoothedLb: this.#bodyweightLb,
        angleDeg: profile.angleDeg[this.#state.level - 1]!,
        boardWeightLb: profile.boardWeightLb,
        pulleyFactor: e.usesPulley ? PULLEY_FACTOR_CABLE : PULLEY_FACTOR_DIRECT,
        bodyFraction: e.bodyFraction,
        vestLb: this.#state.vestLb,
        barLb: this.#state.barLb,
        directLoadLb: 0,
        computedLb: Math.round(this.#computedLb() * 10) / 10,
        formulaVersion: FORMULA_VERSION,
      });

      this.dispatchEvent(
        new CustomEvent('set-logged', { bubbles: true, composed: true, detail: { exerciseId: e.id } }),
      );
    } finally {
      button.disabled = false;
    }
  }
}

customElements.define('tg-set-logger', SetLogger);
