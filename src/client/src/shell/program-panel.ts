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
  observedLevels,
  rampWindow,
  rampedSets,
  sessionPosition,
  sessionProgress,
  type PlannedProgress,
} from '../programs.js';
import {
  budgetMinutesFor,
  estimateMinutes,
  observedSecondsPerSet,
  restSecondsFor,
  setsThatFit,
  supersetPairs,
} from '../session-plan.js';
import type { PlannedExercise, ProgramRecord, ProgramSession } from '../db/schema.js';
import type { ProgramEmphasis, TrainingAim } from '../emphasis.js';

import { toIsoDate } from '../db/schema.js';

import { ios } from './theme.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  .head { display: flex; align-items: center; justify-content: space-between; gap: .5rem;
          min-height: 1.75rem; }
  .sub { color: var(--muted); font-size: var(--text-footnote);
         display: flex; align-items: center; gap: .1rem; }
  /* The session pager: two glyph buttons flanking the position, sized to be hit, not admired. */
  button.step {
    min-width: 2rem; min-height: 2rem; padding: 0;
    font-size: var(--text-body); line-height: 1;
  }
  .browsing { color: var(--warn); }
  p { margin: .4rem 0 0; font-size: var(--text-footnote); }

  ol { list-style: none; margin: .6rem 0 0; padding: 0; }
  li {
    display: flex; align-items: center; gap: .6rem;
    min-height: var(--tap); padding: .1rem 0;
    border-top: var(--hairline) solid var(--separator);
    font-size: var(--text-body);
  }
  li:first-child { border-top: 0; }
  li.done .name { color: var(--muted); text-decoration: line-through; }
  li.next .name { font-weight: 600; }
  .tick { width: 1.1rem; flex: 0 0 1.1rem; text-align: center; color: var(--faint); }
  li.done .tick { color: var(--system-green); }
  .name { flex: 1; text-align: left; font: inherit; background: none; border: 0;
          color: var(--fg); padding: .55rem 0; }
  .sets { color: var(--muted); font-variant-numeric: tabular-nums;
          font-size: var(--text-subhead); }
  .missing { color: var(--warn); font-size: var(--text-caption); }
  li.pairnote { border-top: 0; min-height: 0; padding: 0 0 .35rem 1.7rem;
                font-size: var(--text-caption); color: var(--accent); }
  li.paired .tick { color: var(--accent); }

  .row { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .8rem; }
  select { margin-top: .5rem; }
  .choices { margin-top: .5rem; }
  .choice { border-top: var(--hairline) solid var(--separator); padding: .7rem 0; }
  .choice h4 { margin: 0 0 .15rem; font-size: var(--text-headline); }
  .choice p { margin: 0 0 .55rem; }
`);

export class ProgramPanel extends HTMLElement {
  #root: ShadowRoot;
  #catalog?: ExerciseCatalog;
  #library?: ProgramLibrary;
  #program: ProgramRecord | undefined;
  #session: ProgramSession | undefined;
  #progress: PlannedProgress[] = [];
  /** Sets there is time for at the trainee's observed pace. Infinite until there is history. */
  #room = Number.POSITIVE_INFINITY;
  /** The trainee's own working level per exercise, as a fraction of the rail. */
  #levels: ReadonlyMap<string, number> = new Map();
  /** Notches on this machine's rail, so a logged level can be read as a fraction of it. */
  #levelCount = 12;
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
    this.#root.adoptedStyleSheets = [ios, styles];
  }

  configure(opts: {
    catalog: ExerciseCatalog;
    library: ProgramLibrary;
    /** What the trainee is training for, which orders the templates. */
    emphasis?: ProgramEmphasis;
    /** Sets the rest periods the session estimate is built from. */
    aim?: TrainingAim;
    /** Notches on this rail, so a logged level reads as a fraction of it. */
    levelCount?: number;
  }): void {
    this.#catalog = opts.catalog;
    this.#library = opts.library;
    this.#emphasis = opts.emphasis ?? this.#emphasis;
    this.#aim = opts.aim ?? this.#aim;
    this.#levelCount = opts.levelCount ?? this.#levelCount;
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

  /**
   * How many sets fit the time this trainee actually trains for.
   *
   * Infinite until there is enough history to say, so a new trainee gets the plan as written and
   * the ramp is the only thing shortening it.
   */
  async #roomForSets(history: readonly { sessionId: string }[]): Promise<number> {
    const sessions = await db.listSessions();
    const counts = new Map<string, number>();
    for (const set of history) counts.set(set.sessionId, (counts.get(set.sessionId) ?? 0) + 1);

    const pace = observedSecondsPerSet(
      sessions.map((s) => ({
        startedAt: s.startedAt,
        ...(s.endedAt !== undefined && { endedAt: s.endedAt }),
        setCount: counts.get(s.id) ?? 0,
      })),
    );

    return pace === undefined
      ? Number.POSITIVE_INFINITY
      : setsThatFit(budgetMinutesFor(this.#aim), pace);
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
      // been doing -- the template's numbers are the ceiling, not the opening ask. The window
      // stops YESTERDAY, so working through today's plan cannot change today's plan; see
      // rampWindow.
      const window = rampWindow(Date.now());
      const history = await db.getSetsBetween(window.from, window.to);

      // ...and no further than the trainee actually gets through. A plan they abandon two
      // movements short every week is a plan that is wrong about them, not a trainee who is
      // behind: see observedSecondsPerSet.
      this.#room = await this.#roomForSets(history);

      // The trainee's own working levels beat the catalog's averages for deciding what can be
      // alternated -- "can I row as much as I squat" has no general answer, only theirs.
      this.#levels = observedLevels(history, this.#levelCount);

      this.#plan = this.#session
        ? rampedSets(this.#session.exercises, bestDailySets(history), this.#room)
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
    const minutes = estimateMinutes(this.#plan, this.#catalog, rest, this.#levels);
    // Pairs are computed from the ordered plan, so they mark the movement you alternate with --
    // which is only meaningful because the plan is already ordered by setup.
    this.#pairs = new Map(
      supersetPairs(this.#plan, this.#catalog, rest, this.#levels).flatMap((pair) => [
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
