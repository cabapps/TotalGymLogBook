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
import type { RepAssist } from './rep-assist.js';
import { setFocus } from '../focus.js';

import './rep-assist.js';

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
  /** Smoothed. This is what computes -- see docs/adr/0004. */
  #bodyweightLb = 180;
  /** Raw scale reading, stored alongside for auditability. */
  #bodyweightRawLb = 180;
  #resolveSessionId?: () => Promise<string>;
  /** Undefined means unconfigured, which filters nothing. See ExerciseCatalog.available. */
  #owned: readonly string[] | undefined;
  #state: UiState = { exerciseId: '', level: 8, reps: 10, vestLb: 0, barLb: 0 };

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
  }

  /** Called by the shell once the catalog and machine are known. */
  configure(opts: {
    catalog: ExerciseCatalog;
    profile: RailProfile;
    /** Smoothed bodyweight -- the value the load is computed from. */
    bodyweightLb: number;
    /** Raw scale reading, snapshotted for auditability. */
    bodyweightRawLb?: number;
    /** Accessories owned. Undefined means unconfigured, which shows everything. */
    ownedAttachments?: readonly string[];
    /** Resolved at log time so a session is only created once the trainee actually works. */
    sessionId: () => Promise<string>;
  }): void {
    this.#catalog = opts.catalog;
    this.#profile = opts.profile;
    this.#bodyweightLb = opts.bodyweightLb;
    this.#bodyweightRawLb = opts.bodyweightRawLb ?? opts.bodyweightLb;
    this.#resolveSessionId = opts.sessionId;
    this.#owned = opts.ownedAttachments;

    this.#state = { ...this.#state, ...this.#restore() };
    this.#repairSelection();
    this.#state.level = Math.min(this.#state.level, opts.profile.levelCount);

    this.#render();
  }

  /**
   * Applied when the trainee changes what equipment they own.
   *
   * Re-renders, because the option list itself changed. Repairs the selection first: a select
   * whose selected option has just been filtered away silently falls back to its first option,
   * so the trainee's next set would be logged against a movement they never picked.
   */
  setOwnedAttachments(ownedAttachments: readonly string[] | undefined): void {
    this.#owned = ownedAttachments;
    if (!this.#catalog || !this.#profile) return;

    this.#repairSelection();
    this.#render();
  }

  /**
   * Selects a movement from outside the picker -- tapping an item in today's plan.
   *
   * Falls back to adding it if the equipment filter has hidden it: a planned movement the
   * trainee explicitly asked for must be loggable, or the plan has an item they cannot action.
   */
  selectExercise(exerciseId: string): void {
    if (!this.#catalog?.tryGet(exerciseId)) return;

    this.#state.exerciseId = exerciseId;

    const select = this.#root.getElementById('exercise') as HTMLSelectElement | null;
    if (select && select.querySelector(`option[value="${exerciseId}"]`)) {
      select.value = exerciseId;
      this.#update();
    } else {
      this.#render();
    }

    void this.#assist.setExercise(exerciseId);
  }

  /** Keeps the selected exercise pointing at something that is actually in the list. */
  #repairSelection(): void {
    const available = this.#catalog!.available(this.#owned);
    const stillThere = available.some((e) => e.id === this.#state.exerciseId);

    if (!stillThere) {
      this.#state.exerciseId = available[0]?.id ?? this.#catalog!.all[0]!.id;
    }
  }

  /**
   * Options for the picker: what the trainee owns, plus the current selection even when the
   * filter would exclude it. Without the exception, picking a planned movement they lack the
   * accessory for would silently snap back to something else.
   */
  #pickable(): ReadonlyMap<string, readonly import('../exercises.js').Exercise[]> {
    const groups = new Map(this.#catalog!.grouped(this.#owned));
    const selected = this.#catalog!.tryGet(this.#state.exerciseId);

    if (selected && ![...groups.values()].some((g) => g.some((e) => e.id === selected.id))) {
      groups.set(selected.category, [...(groups.get(selected.category) ?? []), selected]);
    }

    return groups;
  }

  /** Applied after a weigh-in, so the load readout reflects it without losing UI state. */
  setBodyweight(smoothedLb: number, rawLb: number): void {
    this.#bodyweightLb = smoothedLb;
    this.#bodyweightRawLb = rawLb;
    if (this.#catalog && this.#profile) this.#update();
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
    const profile = this.#profile!;
    const s = this.#state;

    this.#root.innerHTML = `
      <div class="card">
        <label for="exercise">Exercise</label>
        <select id="exercise">
          ${[...this.#pickable()]
            .map(
              ([category, exercises]) => `
                <optgroup label="${category}">
                  ${exercises
                    .map(
                      (e) =>
                        `<option value="${e.id}"${e.id === s.exerciseId ? ' selected' : ''}>${e.name}</option>`,
                    )
                    .join('')}
                </optgroup>`,
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
        <tg-rep-assist id="assist"></tg-rep-assist>

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
      void this.#assist.setExercise(s.exerciseId);
      this.#update();
    });

    on('level', 'input', () => {
      s.level = Number((this.#root.getElementById('level') as HTMLInputElement).value);
      this.#update();
    });
    on('reps', 'input', () => {
      s.reps = Number((this.#root.getElementById('reps') as HTMLInputElement).value) || 1;
      this.#assist.syncCount(s.reps);
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

    // An automatic source proposes; the field is still the truth, and the stepper still works
    // while it runs (docs/adr/0006 rule 3).
    this.#assist.addEventListener('reps-detected', (event) => {
      const { count } = (event as CustomEvent<{ count: number }>).detail;
      if (count > 0) this.#setReps(count);
    });
    void this.#assist.setExercise(s.exerciseId);

    this.#update();
  }

  get #assist(): RepAssist {
    return this.#root.getElementById('assist') as RepAssist;
  }

  #nudgeReps(delta: number): void {
    this.#setReps(Math.max(1, this.#state.reps + delta));
    // A manual correction re-anchors the counter, so the next spoken number is measured against
    // what the trainee can actually see rather than against a stale internal total.
    this.#assist.syncCount(this.#state.reps);
  }

  #setReps(reps: number): void {
    this.#state.reps = reps;
    (this.#root.getElementById('reps') as HTMLInputElement).value = String(reps);
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

    // Tell the derived tier what is coming next. Every path that changes the selection funnels
    // through here, and setFocus is a no-op when nothing actually changed.
    setFocus({ exerciseId: e.id });

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
        sessionId: await this.#resolveSessionId!(),
        exerciseId: e.id,
        reps: this.#state.reps,
        level: this.#state.level,
        bodyweightRawLb: this.#bodyweightRawLb,
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

      // Finishing a set ends the count. Voice also stops LISTENING here: a hot microphone
      // through the rest period is the wrong default for something that has no reason to hear
      // anything until the next set starts. Motion keeps running -- the sensor costs the
      // trainee nothing and re-arming it every set is pure friction.
      await this.#assist.finishSet();

      this.dispatchEvent(
        new CustomEvent('set-logged', { bubbles: true, composed: true, detail: { exerciseId: e.id } }),
      );
    } finally {
      button.disabled = false;
    }
  }
}

customElements.define('tg-set-logger', SetLogger);
