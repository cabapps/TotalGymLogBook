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
import type { ExerciseDemo } from './exercise-demo.js';
import { setFocus } from '../focus.js';
import { ios } from './theme.js';

import './rep-assist.js';
import './exercise-demo.js';

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
  .cue { font-size: var(--text-footnote); color: var(--muted); margin: .4rem 0 0; line-height: 1.4; }
  .setup { font-size: var(--text-footnote); color: var(--fg); margin: .5rem 0 0; line-height: 1.45; }
  .setup b { font-weight: 600; }
  button.demo-toggle { margin-top: .6rem; }

  /*
    The load readout is the answer to the only question this screen exists to answer, so it is
    sized like one -- an iOS metric, in the rounded numeric face, not a paragraph with a big
    font-size.
  */
  .load { display: flex; align-items: baseline; gap: .35rem; margin: 1rem 0 .25rem; }
  .load b {
    font-family: var(--font-rounded);
    font-size: var(--text-metric); font-weight: 700; line-height: 1;
    letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
  }
  .load span { color: var(--muted); font-size: var(--text-subhead); }
  .load span#loadNote { font-size: var(--text-caption); }

  .level-row { display: flex; align-items: baseline; justify-content: space-between; }
  .level-row .value { font-size: var(--text-subhead); color: var(--fg);
                      font-variant-numeric: tabular-nums; }

  .log { margin-top: 1.1rem; }
  .row { display: flex; gap: .75rem; }
  .row > * { flex: 1; }
`);

/**
 * How the trainee takes the thing the setup names.
 *
 * "Hold the ankle straps" is wrong in a way that matters: they go around the ankles, and a
 * trainee who reaches for them with their hands has the exercise backwards before they start.
 * The verb comes off the noun rather than being stored alongside it, because the noun already
 * says which one it is -- anything worn goes on, anything the feet go under gets hooked, and
 * everything else is held.
 */
function takeHold(grip: string): string {
  if (grip.startsWith('feet ')) return `hook your ${grip}`;
  if (grip.includes('ankle strap')) return `put on the ${grip}`;
  return `hold the ${grip}`;
}

/** Whether the grip already says which attachment is on the machine. */
function gripNames(attachment: string, grip: string): boolean {
  const words = attachment.toLowerCase().split(/[^a-z-]+/).filter((w) => w.length >= 3);
  return words.some((word) => grip.toLowerCase().includes(word));
}

/**
 * How to set the movement up, in a sentence.
 *
 * Composed from the structured setup rather than written per exercise, so the instructions and
 * the session ordering cannot disagree: the ordering decides two movements can be done back to
 * back precisely because these sentences say the same thing about both.
 *
 * The order is the order you do it in -- get on the board, face the right way, fit the
 * attachment, pick up the handles.
 */
function describeSetup(exercise: Exercise): string {
  const lying: Record<string, string> = {
    'face-up': 'Lie face up on the board',
    'face-down': 'Lie face down on the board',
    'side-lying': 'Lie on your side on the board',
  };

  const toTower = exercise.setup.facing === 'tower';
  const parts: string[] = [];

  // Sitting, the trainee faces a direction; lying, the head points at one. Same axis, and the
  // two readings of it are the only ones the machine has -- nothing is done off the board.
  if (exercise.setup.position === 'seated') {
    parts.push(
      toTower ? 'Sit on the board facing the tower' : 'Sit on the board facing away from the tower',
    );
    // Worth saying out loud: a trainee who knows a movement works both ways can leave the
    // machine as it is rather than turning around for one exercise.
    if (exercise.setup.alsoFacing) parts.push('or the other way round, whichever suits');
  } else if (exercise.setup.position === 'kneeling') {
    parts.push(toTower ? 'Kneel on the board facing the tower' : 'Kneel on the board facing away');
  } else {
    parts.push(lying[exercise.setup.position] ?? 'Get on the board');
    parts.push(toTower ? 'head toward the tower' : 'head toward the floor');
  }

  // "Fit the ankle straps, put on the ankle straps" is what saying both gets you. When the grip
  // already names the attachment, the grip clause has fitting covered -- and the trainee reads
  // one instruction instead of two that look like different steps.
  if (exercise.attachment && !gripNames(exercise.attachment, exercise.setup.grip)) {
    parts.push(`fit the ${exercise.attachment.toLowerCase()}`);
  }

  if (exercise.setup.grip !== 'nothing') parts.push(takeHold(exercise.setup.grip));

  // Three cases, not two.
  //
  // "Pressing straight off the board" was only ever true of the presses -- wrong for a squat, a
  // plank, a pull-up and a crunch, and on the crunch it contradicted the cue outright. What
  // every cable-less movement on this machine has in common is the thing worth saying instead.
  //
  // And a trainee can be holding the handles without working against them: on a reverse crunch
  // the arms only stop you sliding down the rail while the hips do the work. Saying "no cable"
  // there would contradict the handles they are being told to hold, and saying "pulling against
  // the cable" would have them fighting the anchor. The distinction is also what decides whether
  // the load is halved (docs/adr/0004), so it is worth one clause to make it explicit.
  const anchorsOnly = !exercise.usesPulley && /handle|cable/.test(exercise.setup.grip);

  parts.push(
    exercise.usesPulley
      ? 'pulling against the cable'
      : anchorsOnly
        ? 'holding on rather than pulling — the cable is only an anchor here'
        : 'no cable — just your own weight up the rail',
  );

  return `<b>Set up:</b> ${parts.join(', ')}.`;
}

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
  // Reps start at ZERO, not at a guess. A prefilled 10 is a number the trainee has to notice
  // and correct, and the failure is silent: a set logged at 10 reps they did not do reads as
  // real data forever. Zero is obviously not a rep count, so it gets fixed before Log set.
  #state: UiState = { exerciseId: '', level: 8, reps: 0, vestLb: 0, barLb: 0 };
  /** Whether the movement demo is open. Session state, not a setting. */
  #showDemo = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [ios, styles];
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

  /**
   * Whether the trainee owns a piece of added-load kit.
   *
   * Unconfigured shows both, for the same reason it shows every exercise: never having opened
   * the equipment panel is not the same as owning nothing.
   */
  #owns(accessoryId: string): boolean {
    return this.#owned === undefined || this.#owned.includes(accessoryId);
  }

  /**
   * Vest and bar weight, asked for only when the trainee has said they own one.
   *
   * These are on the one screen that has to stay fast (docs/adr/0003), and two number fields
   * that are always zero are two things to scroll past between every set.
   */
  #addedLoadFields(s: UiState): string {
    const vest = this.#owns('weight-vest')
      ? `<div>
           <label for="vest">Vest (lb)</label>
           <input type="number" id="vest" min="0" step="2.5" value="${s.vestLb}" />
         </div>`
      : '';

    const bar = this.#owns('weight-bar')
      ? `<div>
           <label for="bar">Bar (lb)</label>
           <input type="number" id="bar" min="0" step="2.5" value="${s.barLb}" />
         </div>`
      : '';

    return vest || bar ? `<div class="row">${vest}${bar}</div>` : '';
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
        <p class="setup" id="setup"></p>
        <p class="cue" id="cue"></p>
        <button class="demo-toggle" id="demo-toggle" aria-expanded="false">Show me</button>
        <tg-exercise-demo id="demo" hidden></tg-exercise-demo>

        <div class="load">
          <b id="load">—</b><span>lb</span><span id="loadNote"></span>
        </div>

        <div class="level-row">
          <label for="level">Level</label>
          <span class="value" id="levelText">${s.level}</span>
        </div>
        <input type="range" id="level" min="1" max="${profile.levelCount}" step="1" value="${s.level}" />

        <label for="reps">Reps</label>
        <div class="stepper">
          <button id="minus" aria-label="One fewer rep">&minus;</button>
          <input type="number" id="reps" min="0" max="100" value="${s.reps}" />
          <button id="plus" aria-label="One more rep">+</button>
        </div>
        <tg-rep-assist id="assist"></tg-rep-assist>

        ${this.#addedLoadFields(s)}

        <button class="primary log" id="log">Log set</button>
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
      s.reps = Number((this.#root.getElementById('reps') as HTMLInputElement).value) || 0;
      this.#assist.syncCount(s.reps);
      this.#update();
    });
    if (this.#owns('weight-vest')) {
      on('vest', 'input', () => {
        s.vestLb = Number((this.#root.getElementById('vest') as HTMLInputElement).value) || 0;
        this.#update();
      });
    }
    if (this.#owns('weight-bar')) {
      on('bar', 'input', () => {
        s.barLb = Number((this.#root.getElementById('bar') as HTMLInputElement).value) || 0;
        this.#update();
      });
    }
    on('demo-toggle', 'click', () => this.#toggleDemo());
    on('minus', 'click', () => this.#nudgeReps(-1));
    on('plus', 'click', () => this.#nudgeReps(1));
    on('log', 'click', () => void this.#logSet());

    // An automatic source proposes; the field is still the truth, and the stepper still works
    // while it runs (docs/adr/0006 rule 3).
    // Starting a counter resets the field it is going to fill.
    this.#assist.addEventListener('assist-started', () => this.#setReps(0));

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
    this.#setReps(Math.max(0, this.#state.reps + delta));
    // A manual correction re-anchors the counter, so the next spoken number is measured against
    // what the trainee can actually see rather than against a stale internal total.
    this.#assist.syncCount(this.#state.reps);
  }

  /**
   * Shows or hides the drawing.
   *
   * Closed by default and remembered for the session, not stored. Someone who needs it needs it
   * for the first few sessions and then never again, and a demo that has to be dismissed every
   * time is a demo that gets in the way of the logging loop (docs/adr/0003).
   */
  #toggleDemo(): void {
    this.#showDemo = !this.#showDemo;
    this.#renderDemo();
  }

  #renderDemo(): void {
    const demo = this.#root.getElementById('demo') as ExerciseDemo | null;
    const toggle = this.#root.getElementById('demo-toggle');
    if (!demo || !toggle) return;

    demo.hidden = !this.#showDemo;
    toggle.setAttribute('aria-expanded', String(this.#showDemo));
    toggle.textContent = this.#showDemo ? 'Hide the demo' : 'Show me';

    if (this.#showDemo) demo.show(this.#exercise);
    else demo.clear();
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

    // An iOS slider is tinted behind the thumb and gray ahead of it. CSS cannot know where the
    // thumb is, so the value is handed to it as a percentage.
    const slider = this.#root.getElementById('level') as HTMLInputElement;
    const span = this.#profile!.levelCount - 1;
    slider.style.setProperty('--pct', `${span > 0 ? ((this.#state.level - 1) / span) * 100 : 0}%`);
    this.#root.getElementById('cue')!.textContent = e.cue;
    this.#root.getElementById('setup')!.innerHTML = describeSetup(e);
    this.#renderDemo();
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
