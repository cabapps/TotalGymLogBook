/**
 * <tg-program-panel>
 *
 * Today's planned session: what to do, in order, with the sets ticked off as they land.
 *
 * Instant tier, because the answer drives the exercise picker and the picker has to work before
 * the .NET runtime exists (docs/adr/0003). The judgement call about whether the program is any
 * GOOD -- does it give your biceps enough weekly volume -- is the derived half and lives in
 * Blazor.
 *
 * Nothing here is compulsory. The plan is a suggestion with a tick list; the trainee can log
 * whatever they want and the picker never stops offering the full catalog.
 */

import * as db from '../db/repository.js';
import type { ExerciseCatalog } from '../exercises.js';
import {
  ProgramLibrary,
  bestDailySets,
  nextExercise,
  nextSession,
  rampedSets,
  sessionPosition,
  sessionProgress,
  type PlannedProgress,
} from '../programs.js';
import { estimateMinutes, restSecondsFor, supersetPairs } from '../session-plan.js';
import type { PlannedExercise, ProgramRecord, ProgramSession } from '../db/schema.js';
import type { ProgramEmphasis, TrainingAim } from '../emphasis.js';

/**
 * How far back the ramp looks.
 *
 * Long enough that a fortnight off does not reset a trainee to one set, short enough that a
 * volume they abandoned a year ago is not still being asked of them.
 */
const RAMP_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
import { toIsoDate } from '../db/schema.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; margin-bottom: .75rem; }
  /* Without this the host's own display:block wins over [hidden], and the panel stays on
     screen while the trainee is editing the very plan it is showing. */
  :host([hidden]) { display: none; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: .75rem; padding: .9rem 1rem;
  }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; }
  h3 { font-size: .95rem; margin: 0; }
  .sub { color: var(--muted); font-size: .7rem; display: flex; align-items: center; gap: .2rem; }
  button.step {
    font: inherit; font-size: .95rem; line-height: 1; padding: 0 .3rem;
    border: 1px solid var(--border); border-radius: .35rem;
    background: var(--bg); color: var(--fg); cursor: pointer;
  }
  .browsing { color: #b45309; }
  p { margin: .4rem 0 0; font-size: .75rem; color: var(--muted); line-height: 1.45; }
  ol { list-style: none; margin: .7rem 0 0; padding: 0; }
  li {
    display: flex; align-items: center; gap: .5rem;
    padding: .4rem 0; border-top: 1px solid var(--border); font-size: .8125rem;
  }
  li.done .name { color: var(--muted); text-decoration: line-through; }
  li.next .name { font-weight: 650; }
  .tick { width: 1rem; flex: 0 0 1rem; text-align: center; color: var(--muted); }
  li.done .tick { color: var(--accent); }
  .name { flex: 1; text-align: left; font: inherit; background: none; border: 0;
          color: var(--fg); padding: 0; cursor: pointer; }
  .name:hover { color: var(--accent); }
  .sets { color: var(--muted); font-variant-numeric: tabular-nums; font-size: .75rem; }
  .missing { color: #b45309; font-size: .7rem; }
  li.pairnote { border-top: 0; padding: 0 0 .3rem 1.5rem; font-size: .68rem;
                color: var(--accent); }
  li.paired .tick { color: var(--accent); }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .75rem; }
  button.action {
    font: inherit; font-size: .75rem; padding: .35rem .7rem; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--muted); cursor: pointer;
  }
  button.action.primary {
    background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600;
  }
  select { width: 100%; padding: .5rem; font: inherit; border-radius: .5rem; margin-top: .5rem;
           border: 1px solid var(--border); background: var(--bg); color: var(--fg); }
  .choices { margin-top: .5rem; }
  .choice { border-top: 1px solid var(--border); padding: .55rem 0; }
  .choice h4 { margin: 0; font-size: .8125rem; }
  .choice p { margin: .2rem 0 .4rem; }
`);

export class ProgramPanel extends HTMLElement {
  #root: ShadowRoot;
  #catalog?: ExerciseCatalog;
  #library?: ProgramLibrary;
  #program: ProgramRecord | undefined;
  #session: ProgramSession | undefined;
  #progress: PlannedProgress[] = [];
  #plan: PlannedExercise[] = [];
  #picking = false;
  #aim: TrainingAim = 'build-muscle';
  /** Index -> index of the movement it alternates with. */
  #pairs = new Map<number, number>();
  /** How far the trainee has browsed from the session the rotation says is next. */
  #offset = 0;
  #emphasis: ProgramEmphasis = 'lengthened';

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
  }

  configure(opts: {
    catalog: ExerciseCatalog;
    library: ProgramLibrary;
    /** What the trainee is training for, which orders the templates. */
    emphasis?: ProgramEmphasis;
    /** Sets the rest periods the session estimate is built from. */
    aim?: TrainingAim;
  }): void {
    this.#catalog = opts.catalog;
    this.#library = opts.library;
    this.#emphasis = opts.emphasis ?? this.#emphasis;
    this.#aim = opts.aim ?? this.#aim;
    void this.refresh();
  }

  /**
   * The session `offset` places along the rotation from the one the app derived.
   *
   * Whatever is on screen is what gets stamped on the workout, so browsing and choosing are the
   * same action. A separate "do this one instead" button would be a second way to say the thing
   * the trainee has already said by looking at it.
   */
  #atOffset(derived: ProgramSession | undefined): ProgramSession | undefined {
    const sessions = this.#program?.sessions ?? [];
    if (!derived || sessions.length === 0) return derived;

    const from = sessions.findIndex((s) => s.id === derived.id);
    const index = (((from + this.#offset) % sessions.length) + sessions.length) % sessions.length;

    return sessions[index];
  }

  /** The session the trainee is working through, for stamping onto the session record. */
  get plan(): { programId: string; programSessionId: string } | undefined {
    if (!this.#program || !this.#session) return undefined;
    return { programId: this.#program.id, programSessionId: this.#session.id };
  }

  async refresh(): Promise<void> {
    this.#program = await db.getActiveProgram();

    if (this.#program) {
      const sessions = await db.listSessions();
      const derived = nextSession(this.#program, sessions);

      // Once a workout is under way, browsing has been resolved: the session being worked is the
      // session, and the arrows should count from it rather than from wherever the trainee had
      // scrolled to before they started.
      if (sessions.some((s) => s.status === 'active' && s.programSessionId !== undefined)) {
        this.#offset = 0;
      }

      // Browsing the rotation moves this off zero. The DERIVED session is still what the app
      // works out on its own; the offset is the trainee overruling it for today, which they are
      // allowed to do -- they know they did legs yesterday somewhere the app could not see.
      this.#session = this.#atOffset(derived);

      // Progress counts sets logged TODAY rather than sets on this session record. Closing the
      // app mid-workout starts a new record, but it is obviously the same workout to the
      // trainee, and a tick list that resets itself would be worse than none.
      const today = toIsoDate(Date.now());
      const sets = await db.getSetsBetween(today, today);

      // The plan starts at one set per movement and grows with what the trainee has actually
      // been doing -- the template's numbers are the ceiling, not the opening ask.
      const history = await db.getSetsBetween(toIsoDate(Date.now() - RAMP_WINDOW_MS), today);
      this.#plan = this.#session
        ? rampedSets(this.#session.exercises, bestDailySets(history))
        : [];

      this.#progress = this.#session
        ? sessionProgress({ ...this.#session, exercises: this.#plan }, sets)
        : [];
    } else {
      this.#session = undefined;
      this.#plan = [];
      this.#progress = [];
    }

    this.#render();
  }

  #render(): void {
    if (!this.#catalog || !this.#library) return;

    if (this.#picking || !this.#program) {
      this.#renderPicker();
      return;
    }

    const done = this.#progress.filter((p) => p.done).length;
    const upNext = nextExercise(this.#progress);
    const position = this.#session ? sessionPosition(this.#program, this.#session.id) : 0;

    const rest = restSecondsFor(this.#aim);
    const minutes = estimateMinutes(this.#plan, this.#catalog, rest);
    // Pairs are computed from the ordered plan, so they mark the movement you alternate with --
    // which is only meaningful because the plan is already ordered by setup.
    this.#pairs = new Map(
      supersetPairs(this.#plan, this.#catalog, rest).flatMap((pair) => [
        [pair.first, pair.second],
        [pair.second, pair.first],
      ]),
    );

    this.#root.innerHTML = `
      <div class="card">
        <div class="head">
          <h3 id="session-name">${this.#session?.name ?? this.#program.name}</h3>
          <span class="sub" id="session-position">
            <button class="step" id="prev" aria-label="Previous session">&lsaquo;</button>
            ${position} of ${this.#program.sessions.length}
            <button class="step" id="next" aria-label="Next session">&rsaquo;</button>
            ${minutes > 0 ? `&middot; <span id="session-minutes">~${minutes} min</span>` : ''}
          </span>
        </div>

        ${
          this.#offset === 0
            ? ''
            : `<p class="browsing" id="browsing">
                 Not the one you were due &mdash; log a set and this becomes today's session.
               </p>`
        }

        ${
          this.#session
            ? `<ol id="plan">${this.#progress.map((p) => this.#renderItem(p, upNext)).join('')}</ol>`
            : '<p>This program has no sessions yet.</p>'
        }

        <div class="row">
          ${done === this.#progress.length && this.#progress.length > 0
            ? '<span class="sub" id="session-complete">Session complete. Nice.</span>'
            : ''}
          <button class="action" id="edit">Edit</button>
          <button class="action" id="change">Change program</button>
        </div>
      </div>
    `;

    // Tapping a planned movement selects it in the logger. That is the whole interaction --
    // the plan drives the picker, it does not replace it.
    for (const [index, item] of this.#progress.entries()) {
      this.#root.getElementById(`pick-${index}`)?.addEventListener('click', () => {
        this.dispatchEvent(
          new CustomEvent('plan-exercise-picked', {
            bubbles: true,
            composed: true,
            detail: { exerciseId: item.planned.exerciseId },
          }),
        );
      });
    }

    this.#root.getElementById('prev')!.addEventListener('click', () => void this.#step(-1));
    this.#root.getElementById('next')!.addEventListener('click', () => void this.#step(1));

    this.#root.getElementById('edit')!.addEventListener('click', () => {
      this.dispatchEvent(
        new CustomEvent('program-edit-requested', {
          bubbles: true,
          composed: true,
          detail: { programId: this.#program!.id },
        }),
      );
    });

    this.#root.getElementById('change')!.addEventListener('click', () => {
      this.#picking = true;
      this.#render();
    });
  }

  #renderItem(item: PlannedProgress, upNext: { exerciseId: string } | undefined): string {
    const index = this.#progress.indexOf(item);
    const exercise = this.#catalog!.tryGet(item.planned.exerciseId);
    const isNext = upNext?.exerciseId === item.planned.exerciseId;

    // A planned movement the catalog no longer has -- an exercise the trainee deleted, or a
    // template referencing something removed. Say so rather than rendering a blank row.
    const name = exercise?.name ?? item.planned.exerciseId;

    // Alternating with the movement above only makes sense once you are past the first of the
    // pair, so it is marked on the second one.
    const partner = this.#pairs.get(index);
    const paired = partner !== undefined && partner < index;

    return `
      <li class="${item.done ? 'done' : ''} ${isNext ? 'next' : ''} ${paired ? 'paired' : ''}">
        <span class="tick">${item.done ? '&check;' : paired ? '&#8645;' : '&middot;'}</span>
        <button class="name" id="pick-${index}">${name}</button>
        <span class="sets">${item.logged}/${item.planned.sets}</span>
        ${exercise ? '' : '<span class="missing">not in your list</span>'}
      </li>
      ${paired ? '<li class="pairnote">alternate these two — rest once per round</li>' : ''}
    `;
  }

  /** Moves along the rotation. Refreshing rebuilds the plan and the tick list with it. */
  async #step(delta: number): Promise<void> {
    this.#offset += delta;
    await this.refresh();
  }

  #renderPicker(): void {
    // Ordered by what the trainee is training for, never filtered. Someone training for strength
    // who wants to run a hypertrophy split is allowed to; hiding it would be the app overruling
    // a decision that is theirs.
    const templates = this.#library!.forEmphasis(this.#emphasis);

    this.#root.innerHTML = `
      <div class="card">
        <h3>Follow a program</h3>
        <p>
          A program is a rotation of sessions, not a calendar. Miss a day and you pick up where
          you left off &mdash; nothing goes red.
        </p>

        <div class="choices">
          ${templates
            .map(
              (t, index) => `
                <div class="choice">
                  <h4>${t.name}</h4>
                  <p>${t.description}<br><em>${t.bestFor}</em></p>
                  <button class="action primary" id="use-${index}">Use ${t.name}</button>
                </div>`,
            )
            .join('')}
        </div>

        <div class="row">
          <button class="action" id="build">Build my own</button>
          <button class="action" id="freestyle">
            ${this.#program ? 'Stop following a program' : 'No thanks &mdash; I&rsquo;ll freestyle'}
          </button>
        </div>
      </div>
    `;

    for (const [index, template] of templates.entries()) {
      this.#root.getElementById(`use-${index}`)!.addEventListener('click', async () => {
        await db.saveProgram({
          name: template.name,
          description: template.description,
          templateId: template.id,
          // Deep-copied on purpose: the trainee owns their copy from here, and editing it must
          // not mutate the shipped template for every future program they start.
          sessions: template.sessions.map((s) => ({
            ...s,
            exercises: s.exercises.map((e) => ({ ...e })),
          })),
          isActive: true,
        });

        this.#picking = false;
        await this.refresh();
        this.#announce();
      });
    }

    this.#root.getElementById('build')!.addEventListener('click', () => {
      this.#picking = false;
      this.dispatchEvent(
        new CustomEvent('program-edit-requested', {
          bubbles: true,
          composed: true,
          detail: {},
        }),
      );
    });

    this.#root.getElementById('freestyle')!.addEventListener('click', async () => {
      await db.setActiveProgram(undefined);
      this.#picking = false;
      await this.refresh();
      this.#announce();
    });
  }

  #announce(): void {
    this.dispatchEvent(new CustomEvent('program-changed', { bubbles: true, composed: true }));
  }
}

customElements.define('tg-program-panel', ProgramPanel);
