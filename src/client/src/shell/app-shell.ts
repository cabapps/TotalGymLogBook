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

import { ios } from './theme.js';

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
  :host { display: block; }

  /*
    The nav bar. Sticky, and it extends UNDER the status bar via the top safe-area inset -- a
    bar that stops below the notch reads as a web page with a gray strip on top, which is
    exactly the thing this change exists to stop.

    The material is the point: iOS bars are translucent and blur what scrolls beneath them.
    backdrop-filter is what makes a fixed header feel like part of the OS rather than a div.
  */
  .navbar {
    position: sticky; top: 0; z-index: 50;
    padding-top: env(safe-area-inset-top);
    background: var(--material);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    backdrop-filter: saturate(180%) blur(20px);
    /* The hairline appears only once something has scrolled under the bar -- see .condensed. */
    border-bottom: var(--hairline) solid transparent;
    transition: border-color .2s ease;
  }
  .navbar-inner {
    max-width: 34rem; margin: 0 auto; height: var(--tap);
    display: flex; align-items: center; justify-content: center;
    padding: 0 var(--gutter);
  }
  /*
    The large title collapses into the bar as you scroll: the iOS navigation pattern, and the
    single strongest signal that a screen is native rather than a document.
  */
  .navbar-title {
    font-size: var(--text-headline); font-weight: 600; letter-spacing: -0.01em;
    opacity: 0; transform: translateY(.4rem);
    transition: opacity .2s ease, transform .2s ease;
  }
  .navbar.condensed { border-bottom-color: var(--separator); }
  .navbar.condensed .navbar-title { opacity: 1; transform: none; }

  .screen {
    max-width: 34rem; margin: 0 auto;
    padding: .25rem var(--gutter) calc(3rem + env(safe-area-inset-bottom));
  }

  h1 {
    font-size: var(--text-large-title); font-weight: 700; letter-spacing: -0.022em;
    line-height: 1.1; margin: .35rem 0 .2rem;
  }
  .sub { color: var(--muted); font-size: var(--text-subhead); margin: 0 0 1.1rem; }

  .card p { color: var(--fg); font-size: var(--text-body); }
  .card p + button { margin-top: .5rem; }
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
  /** Watches the large title so the nav bar can take it over on scroll. */
  #titleWatch?: IntersectionObserver;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [ios, styles];
  }

  async connectedCallback(): Promise<void> {
    this.#root.innerHTML = `<div class="screen"><p class="sub">Loading&hellip;</p></div>`;

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

  // ---------------------------------------------------------------- chrome

  /**
   * Wraps a screen in the navigation bar and the large title.
   *
   * The title is written twice on purpose: once large in the content, once compact in the bar.
   * The observer below cross-fades between them on scroll, which is how every stock iOS screen
   * behaves and is not something CSS can do on its own.
   */
  #chrome(title: string, subtitle: string, body: string): string {
    return `
      <header class="navbar" id="navbar">
        <div class="navbar-inner"><span class="navbar-title">${title}</span></div>
      </header>
      <main class="screen">
        <h1 id="large-title">${title}</h1>
        <p class="sub">${subtitle}</p>
        ${body}
      </main>
    `;
  }

  /**
   * Condenses the nav bar once the large title has scrolled under it.
   *
   * rootMargin is measured from the bar rather than hardcoded, because the bar's height is the
   * status bar inset plus 44pt and the inset is different on every device -- and zero on a
   * desktop browser, where a hardcoded 91px would condense the title while it was still on
   * screen.
   */
  #watchTitle(): void {
    this.#titleWatch?.disconnect();

    const navbar = this.#root.getElementById('navbar');
    const title = this.#root.getElementById('large-title');
    if (!navbar || !title || typeof IntersectionObserver !== 'function') return;

    this.#titleWatch = new IntersectionObserver(
      ([entry]) => navbar.classList.toggle('condensed', !entry!.isIntersecting),
      { rootMargin: `-${Math.round(navbar.getBoundingClientRect().height)}px 0px 0px 0px` },
    );
    this.#titleWatch.observe(title);
  }

  // ---------------------------------------------------------------- onboarding

  #renderOnboarding(): void {
    const profiles = this.#profiles!;

    this.#root.innerHTML = this.#chrome(
      'Total Gym Logbook',
      "Three questions and you're logging.",
      `
      <div class="card">
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
      </div>

      <button class="primary" id="start">Start logging</button>
    `,
    );
    this.#watchTitle();

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

    this.#root.innerHTML = this.#chrome(
      'Unfinished workout',
      `Still open from ${started.toLocaleString()}.`,
      `
      <div class="card">
        <p>Pick it up where you left off, or close it and start a new session.</p>
      </div>
      <button class="primary" id="resume">Resume it</button>
      <button class="ghost destructive" id="close">Close it and start fresh</button>
    `,
    );
    this.#watchTitle();

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
    this.#root.innerHTML = this.#chrome(
      'Log a set',
      `<span id="bwLabel">${this.#bodyweightLb.toFixed(1)} lb</span> &middot; ${this.#profile!.levelCount} notches`,
      `
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
    `,
    );
    this.#watchTitle();

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
