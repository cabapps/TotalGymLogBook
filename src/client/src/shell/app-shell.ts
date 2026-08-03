/**
 * <tg-app-shell>
 *
 * The instant tier (docs/adr/0003): paints and becomes fully usable for logging before the
 * .NET runtime exists. Blazor renders derived views (coaching, history, charts) into
 * #blazor-root underneath, whenever it finishes booting.
 *
 * Three screens, chosen by what the logbook already knows:
 *   onboarding  no machine or bodyweight yet -- three questions, per docs/adr/0010
 *   resume      an 'active' session older than a few hours (docs/adr/0005)
 *   workout     the logging loop
 */

import * as db from '../db/repository.js';
import { ExerciseCatalog } from '../exercises.js';
import { RailProfileTable } from '../profiles.js';
import { ProgramLibrary } from '../programs.js';
import { toIsoDate, type SessionRecord } from '../db/schema.js';
import type { RailProfile } from '../resistance.js';
import type { SetLogger } from './set-logger.js';
import type { SessionList } from './session-list.js';
import type { RestTimer } from './rest-timer.js';
import type { WeighIn } from './weigh-in.js';
import type { Equipment } from './equipment.js';
import type { ProgramPanel } from './program-panel.js';
import type { ProgramEditor } from './program-editor.js';
import type { ExerciseEditor } from './exercise-editor.js';
import { smoothedLb, toReadings } from '../bodyweight.js';
import {
  emphasisFor,
  goalFor,
  type ProgramEmphasis,
  type TrainingAim,
} from '../emphasis.js';

/**
 * The trainee's stated aim, falling back to what their goal implies.
 *
 * The fallback is for logbooks written before the aim was recorded: they answered the same
 * question, and the answer was flattened to a training style on the way in. Recovering the aim
 * from it loses only the fat-loss distinction, which was never stored to begin with.
 */
function aimOf(settings: { aim?: string; goalPrimary?: string }): TrainingAim {
  if (settings.aim) return settings.aim as TrainingAim;

  switch (settings.goalPrimary) {
    case 'Strength':
      return 'get-stronger';
    case 'Aerobic':
      return 'endurance';
    case 'Rehab':
      return 'rehab';
    default:
      return 'build-muscle';
  }
}
import type { CustomExerciseRecord } from '../db/schema.js';
import type { Exercise } from '../exercises.js';

/** A stored custom exercise as the catalog wants it. Same shape, different provenance. */
function toExercise(record: CustomExerciseRecord): Exercise {
  return {
    id: record.id,
    name: record.name,
    category: record.category,
    kind: record.kind,
    usesPulley: record.usesPulley,
    peakTension: record.peakTension ?? 'even',
    pattern: record.pattern ?? 'press',
    typicalLevel: record.typicalLevel ?? 0.5,
    // A movement added before the setup question existed falls back to the machine's default
    // posture, which is also where the session ordering will assume the trainee is.
    setup: record.setup ?? {
      position: 'supine',
      facing: 'tower',
      grip: record.usesPulley ? 'handles' : 'nothing',
    },
    bodyFraction: record.bodyFraction,
    attachment: record.attachment,
    cue: record.cue,
    muscles: record.muscles,
  };
}

import './set-logger.js';
import './session-list.js';
import './rest-timer.js';
import './weigh-in.js';
import './program-panel.js';
import './program-editor.js';
import './exercise-editor.js';
import './equipment.js';
import './data-safety.js';

const DEFAULT_REST_SECONDS = 90;

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; padding: 1rem; max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.15rem; margin: 0 0 .15rem; }
  .sub { color: var(--muted); font-size: .8125rem; margin: 0 0 1rem; }
  label { display: block; font-size: .75rem; color: var(--muted); margin: .85rem 0 .25rem; }
  input, select {
    width: 100%; padding: .55rem; font: inherit; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  }
  button.primary {
    width: 100%; margin-top: 1.1rem; padding: .8rem; font: inherit; font-weight: 600;
    border: 0; border-radius: .65rem; background: var(--accent); color: #fff; cursor: pointer;
  }
  button.ghost {
    width: 100%; margin-top: .5rem; padding: .6rem; font: inherit;
    border: 1px solid var(--border); border-radius: .65rem;
    background: transparent; color: var(--muted); cursor: pointer;
  }
  .bar { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: .5rem; }
  .bar small { color: var(--muted); font-size: .75rem; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: .75rem; padding: 1rem; margin-bottom: .75rem;
  }
  .card p { margin: 0 0 .5rem; font-size: .875rem; line-height: 1.45; }
`);

export class AppShell extends HTMLElement {
  #root: ShadowRoot;
  #catalog?: ExerciseCatalog;
  /** The shipped catalog, kept separately so re-merging cannot stack custom entries. */
  #builtIn?: ExerciseCatalog;
  #library?: ProgramLibrary;
  #profiles?: RailProfileTable;
  #profile?: RailProfile;
  #machineId?: string;
  /** Accessories owned. Undefined means never configured, which shows every exercise. */
  #owned: readonly string[] | undefined;
  /**
   * What the program builder ranks movements by.
   *
   * Derived from the STATED aim only. Whether the trainee is actually in a deficit is a phase
   * call, and docs/adr/0010 puts phase calls in C# -- the shell observes, the coach labels. So a
   * trainee who set out to build muscle but has been losing weight hears about it from the
   * coach, and the shell does not quietly relabel their goal underneath them.
   */
  #emphasis: ProgramEmphasis = 'lengthened';
  #aim: TrainingAim = 'build-muscle';
  /** Smoothed -- what the resistance calculation uses (docs/adr/0004). */
  #bodyweightLb = 0;
  /** Raw latest scale reading, snapshotted alongside for auditability. */
  #bodyweightRawLb = 0;
  #session: SessionRecord | undefined;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
  }

  async connectedCallback(): Promise<void> {
    this.#root.innerHTML = `<p class="sub">Loading&hellip;</p>`;

    const [catalog, profilesJson, library, custom] = await Promise.all([
      ExerciseCatalog.load(),
      fetch('data/rail-profiles.json').then((r) => r.text()),
      ProgramLibrary.load(),
      db.listCustomExercises(),
    ]);

    // The trainee's own movements merge into the shipped catalog, so everything downstream --
    // picker, load calculation, program plans -- sees one list.
    this.#builtIn = catalog;
    this.#catalog = catalog.withCustom(custom.map(toExercise));
    this.#library = library;
    this.#profiles = RailProfileTable.parse(profilesJson);

    await this.#route();
  }

  async #route(): Promise<void> {
    const machine = await db.getDefaultMachine();
    const latest = await db.getLatestBodyweight();

    if (!machine || !latest) {
      this.#renderOnboarding();
      return;
    }

    this.#profile = this.#profiles!.get(machine.railProfileId);

    const settings = await db.getSettings();
    // Accessories added since this answer was given are treated as unanswered, not as "no" --
    // otherwise an app update quietly removes exercises from the picker (ExerciseCatalog.resolveOwned).
    this.#owned = this.#catalog!.resolveOwned(
      settings.ownedAttachments,
      settings.equipmentVersion,
    );
    this.#aim = aimOf(settings);
    this.#emphasis = emphasisFor(this.#aim);
    await this.#refreshBodyweight();

    // docs/adr/0005: never auto-close an orphan (discards data) and never auto-resume
    // (pollutes today). Ask.
    const orphans = await db.findOrphanedSessions(6);
    if (orphans.length > 0) {
      this.#renderResume(orphans[0]!);
      return;
    }

    // Sessions are created LAZILY, on the first logged set -- see #ensureSession.
    //
    // Creating one here meant every app open produced a session, so glancing at the app and
    // closing it left an empty 'active' session that later surfaced as "you have an unfinished
    // workout". Opening the app is not starting a workout.
    this.#machineId = machine.id;
    this.#session = await db.getActiveSession();

    this.#renderWorkout();
  }

  /**
   * Creates the session on demand. Called when a set is about to be logged, never on load.
   */
  async #ensureSession(): Promise<string> {
    // The plan is stamped on at creation, which is what lets the rotation be derived from
    // history later rather than tracked by a cursor that drifts.
    const plan = (this.#root.getElementById('program') as ProgramPanel | null)?.plan;

    this.#session ??= await db.startSession({
      machineId: this.#machineId!,
      bodyweightRawLb: this.#bodyweightRawLb,
      bodyweightSmoothedLb: this.#bodyweightLb,
      ...(plan ?? {}),
    });
    return this.#session.id;
  }

  /**
   * Recomputes the smoothed weight. The raw reading is stored for auditability, but the EMA is
   * what computes: a 3 lb water swing must not rewrite every load figure the user sees.
   */
  async #refreshBodyweight(): Promise<void> {
    const readings = toReadings(await db.getBodyweightReadings());
    const latest = readings[readings.length - 1];

    this.#bodyweightRawLb = latest?.lb ?? this.#bodyweightRawLb;
    this.#bodyweightLb = smoothedLb(readings) ?? this.#bodyweightRawLb;
  }

  // ---------------------------------------------------------------- onboarding

  #renderOnboarding(): void {
    const profiles = this.#profiles!;

    this.#root.innerHTML = `
      <h1>Total Gym Logbook</h1>
      <p class="sub">Three questions and you're logging.</p>

      <label for="bw">What do you weigh? (lb)</label>
      <input type="number" id="bw" min="50" max="500" step="0.1" value="180" />

      <label for="notches">How many notches are on your rail?</label>
      <select id="notches">
        ${profiles.profiles
          .slice()
          .sort((a, b) => a.levelCount - b.levelCount)
          .map(
            (p) =>
              `<option value="${p.id}"${p.levelCount === 14 ? ' selected' : ''}>${p.levelCount} levels</option>`,
          )
          .join('')}
      </select>

      <label for="goal">What are you working toward?</label>
      <select id="goal">
        <option value="build-muscle">Build muscle</option>
        <option value="lose-fat">Lose weight</option>
        <option value="get-stronger">Get stronger</option>
        <option value="endurance">Improve endurance</option>
        <option value="rehab">Recover from an injury</option>
      </select>

      <button class="primary" id="start">Start logging</button>
    `;

    this.#root.getElementById('start')!.addEventListener('click', async () => {
      const lb = Number((this.#root.getElementById('bw') as HTMLInputElement).value);
      const railProfileId = (this.#root.getElementById('notches') as HTMLSelectElement).value;
      const aim = (this.#root.getElementById('goal') as HTMLSelectElement).value as TrainingAim;

      if (!Number.isFinite(lb) || lb <= 0) return;

      const profile = this.#profiles!.get(railProfileId);
      await db.saveMachine({
        name: `${profile.levelCount}-notch Total Gym`,
        railProfileId,
        isDefault: true,
      });
      await db.recordBodyweight(toIsoDate(Date.now()), lb);
      // Both: the derived training style everything downstream already reads, and the answer
      // as given. "Lose weight" and "build muscle" derive the same style but are not the same
      // request -- see SettingsRecord.aim.
      await db.saveSettings({ aim, goalPrimary: goalFor(aim) });

      await this.#route();
    });
  }

  // ---------------------------------------------------------------- resume

  #renderResume(orphan: SessionRecord): void {
    const started = new Date(orphan.startedAt);

    this.#root.innerHTML = `
      <h1>Unfinished workout</h1>
      <div class="card">
        <p>You have a session still open from ${started.toLocaleString()}.</p>
        <button class="primary" id="resume">Resume it</button>
        <button class="ghost" id="close">Close it and start fresh</button>
      </div>
    `;

    this.#root.getElementById('resume')!.addEventListener('click', () => {
      this.#session = orphan;
      this.#renderWorkout();
    });

    this.#root.getElementById('close')!.addEventListener('click', async () => {
      await db.endSession(orphan.id, 'abandoned');
      await this.#route();
    });
  }

  // ---------------------------------------------------------------- workout

  #renderWorkout(): void {
    this.#root.innerHTML = `
      <div class="bar">
        <h1>Log a set</h1>
        <small><span id="bwLabel">${this.#bodyweightLb.toFixed(1)} lb</span> &middot; ${this.#profile!.levelCount} notches</small>
      </div>

      <tg-rest-timer id="timer" hidden></tg-rest-timer>
      <tg-weigh-in id="weight"></tg-weigh-in>
      <tg-program-panel id="program"></tg-program-panel>
      <tg-program-editor id="builder"></tg-program-editor>
      <tg-set-logger id="logger"></tg-set-logger>
      <tg-session-list id="list"></tg-session-list>

      <button class="ghost" id="finish">Finish workout</button>

      <tg-equipment id="equipment"></tg-equipment>
      <tg-exercise-editor id="editor"></tg-exercise-editor>

      <!-- Blazor's #blazor-root is projected here (see index.html). The coach and history are
           the payoff for logging, so they sit directly under the workout rather than below the
           data card, where nobody scrolled to find them. The slot exists only on this screen:
           an unslotted light child is not rendered, which is exactly the behavior we want
           during onboarding and the resume prompt. -->
      <slot name="derived"></slot>

      <tg-data-safety></tg-data-safety>
    `;

    const logger = this.#root.getElementById('logger') as SetLogger;
    const list = this.#root.getElementById('list') as SessionList;
    const timer = this.#root.getElementById('timer') as RestTimer;

    logger.configure({
      catalog: this.#catalog!,
      profile: this.#profile!,
      bodyweightLb: this.#bodyweightLb,
      bodyweightRawLb: this.#bodyweightRawLb,
      ...(this.#owned !== undefined && { ownedAttachments: this.#owned }),
      // Resolved at log time, so no session exists until the trainee actually works.
      sessionId: () => this.#ensureSession(),
    });

    const program = this.#root.getElementById('program') as ProgramPanel;
    program.configure({
      catalog: this.#catalog!,
      library: this.#library!,
      emphasis: this.#emphasis,
      aim: this.#aim,
      levelCount: this.#profile!.levelCount,
    });

    // Tapping a planned movement selects it. The plan drives the picker; it never replaces it.
    program.addEventListener('plan-exercise-picked', (event) => {
      const { exerciseId } = (event as CustomEvent<{ exerciseId: string }>).detail;
      logger.selectExercise(exerciseId);
    });

    const builder = this.#root.getElementById('builder') as ProgramEditor;
    builder.configure({
      catalog: this.#catalog!,
      emphasis: this.#emphasis,
      aim: this.#aim,
      ...(this.#owned !== undefined && { ownedAttachments: this.#owned }),
    });

    // Editing is a mode, not a screen: the panel steps aside while the builder is open so the
    // trainee is never looking at today's plan and the plan they are rewriting at once.
    program.addEventListener('program-edit-requested', async (event) => {
      const { programId } = (event as CustomEvent<{ programId?: string }>).detail;
      const existing = programId ? await db.getProgram(programId) : undefined;

      program.hidden = true;
      builder.edit(existing);
    });

    builder.addEventListener('editor-closed', () => {
      program.hidden = false;
    });

    builder.addEventListener('program-changed', async () => {
      program.hidden = false;
      await program.refresh();
    });

    const editor = this.#root.getElementById('editor') as ExerciseEditor;
    editor.configure({
      catalog: this.#catalog!,
      profile: this.#profile!,
      bodyweightLb: this.#bodyweightLb,
    });

    // A new movement has to reach the picker, the plan, and the load calculation at once, so
    // the merged catalog is rebuilt rather than patched.
    editor.addEventListener('exercises-changed', async () => {
      const custom = await db.listCustomExercises();
      this.#catalog = this.#builtIn!.withCustom(custom.map(toExercise));

      logger.configure({
        catalog: this.#catalog,
        profile: this.#profile!,
        bodyweightLb: this.#bodyweightLb,
        bodyweightRawLb: this.#bodyweightRawLb,
        ...(this.#owned !== undefined && { ownedAttachments: this.#owned }),
        sessionId: () => this.#ensureSession(),
      });
      program.configure({
        catalog: this.#catalog,
        library: this.#library!,
        emphasis: this.#emphasis,
        aim: this.#aim,
        levelCount: this.#profile!.levelCount,
      });
      list.configure({ catalog: this.#catalog, ...(this.#session && { sessionId: this.#session.id }) });
    });

    const equipment = this.#root.getElementById('equipment') as Equipment;
    equipment.configure({ catalog: this.#catalog! });

    // Ticking an accessory reshapes the exercise list immediately, rather than at next launch.
    equipment.addEventListener('equipment-changed', (event) => {
      this.#owned = (event as CustomEvent<{ ownedAttachments: string[] }>).detail.ownedAttachments;
      logger.setOwnedAttachments(this.#owned);
    });
    list.configure({ catalog: this.#catalog!, ...(this.#session && { sessionId: this.#session.id }) });

    // Logging a set starts the rest clock, and is also the moment the session first exists,
    // so point the list at it now.
    logger.addEventListener('set-logged', () => {
      timer.start(DEFAULT_REST_SECONDS);
      if (this.#session) list.configure({ catalog: this.#catalog!, sessionId: this.#session.id });
      void program.refresh();
    });

    // A weigh-in changes every load figure, so push the new value straight into the logger
    // rather than rebuilding it -- rebuilding would lose the in-flight rep count.
    const weight = this.#root.getElementById('weight') as WeighIn;
    weight.addEventListener('weighed-in', async () => {
      await this.#refreshBodyweight();
      logger.setBodyweight(this.#bodyweightLb, this.#bodyweightRawLb);
      this.#root.getElementById('bwLabel')!.textContent =
        `${this.#bodyweightLb.toFixed(1)} lb`;
    });

    this.#root.getElementById('finish')!.addEventListener('click', async () => {
      // Nothing logged means there is no session to end, which is the point of lazy creation.
      if (this.#session) await db.endSession(this.#session.id);
      this.#session = undefined;
      timer.stop();
      await this.#route();
    });
  }
}

customElements.define('tg-app-shell', AppShell);
