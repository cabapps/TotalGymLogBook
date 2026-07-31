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
import { toIsoDate, type SessionRecord } from '../db/schema.js';
import type { RailProfile } from '../resistance.js';
import type { SetLogger } from './set-logger.js';
import type { SessionList } from './session-list.js';
import type { RestTimer } from './rest-timer.js';
import type { WeighIn } from './weigh-in.js';
import { smoothedLb, toReadings } from '../bodyweight.js';

import './set-logger.js';
import './session-list.js';
import './rest-timer.js';
import './weigh-in.js';

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
  #profiles?: RailProfileTable;
  #profile?: RailProfile;
  /** Smoothed -- what the resistance calculation uses (docs/adr/0004). */
  #bodyweightLb = 0;
  /** Raw latest scale reading, snapshotted alongside for auditability. */
  #bodyweightRawLb = 0;
  #session?: SessionRecord;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
  }

  async connectedCallback(): Promise<void> {
    this.#root.innerHTML = `<p class="sub">Loading&hellip;</p>`;

    const [catalog, profilesJson] = await Promise.all([
      ExerciseCatalog.load(),
      fetch('data/rail-profiles.json').then((r) => r.text()),
    ]);
    this.#catalog = catalog;
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
    await this.#refreshBodyweight();

    // docs/adr/0005: never auto-close an orphan (discards data) and never auto-resume
    // (pollutes today). Ask.
    const orphans = await db.findOrphanedSessions(6);
    if (orphans.length > 0) {
      this.#renderResume(orphans[0]!);
      return;
    }

    this.#session = await db.startSession({
      machineId: machine.id,
      bodyweightRawLb: this.#bodyweightRawLb,
      bodyweightSmoothedLb: this.#bodyweightLb,
    });

    this.#renderWorkout();
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
      <p class="sub" style="margin:.4rem 0 0">
        Count them on the tower &mdash; model names are unreliable. The FIT and FIT Anniversary
        share a name but have 12 and 14.
      </p>

      <label for="goal">What are you working toward?</label>
      <select id="goal">
        <option value="Hypertrophy">Build muscle</option>
        <option value="Hypertrophy">Lose weight</option>
        <option value="Strength">Get stronger</option>
        <option value="Aerobic">Improve endurance</option>
        <option value="Rehab">Recover from an injury</option>
      </select>

      <button class="primary" id="start">Start logging</button>
    `;

    this.#root.getElementById('start')!.addEventListener('click', async () => {
      const lb = Number((this.#root.getElementById('bw') as HTMLInputElement).value);
      const railProfileId = (this.#root.getElementById('notches') as HTMLSelectElement).value;
      const goal = (this.#root.getElementById('goal') as HTMLSelectElement).value;

      if (!Number.isFinite(lb) || lb <= 0) return;

      const profile = this.#profiles!.get(railProfileId);
      await db.saveMachine({
        name: `${profile.levelCount}-notch Total Gym`,
        railProfileId,
        isDefault: true,
      });
      await db.recordBodyweight(toIsoDate(Date.now()), lb);
      await db.saveSettings({ goalPrimary: goal });

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
      <tg-set-logger id="logger"></tg-set-logger>
      <tg-session-list id="list"></tg-session-list>

      <button class="ghost" id="finish">Finish workout</button>
    `;

    const logger = this.#root.getElementById('logger') as SetLogger;
    const list = this.#root.getElementById('list') as SessionList;
    const timer = this.#root.getElementById('timer') as RestTimer;

    logger.configure({
      catalog: this.#catalog!,
      profile: this.#profile!,
      bodyweightLb: this.#bodyweightLb,
      bodyweightRawLb: this.#bodyweightRawLb,
      sessionId: this.#session!.id,
    });
    list.configure({ catalog: this.#catalog!, sessionId: this.#session!.id });

    // Logging a set starts the rest clock. The list updates itself off the change bus.
    logger.addEventListener('set-logged', () => timer.start(DEFAULT_REST_SECONDS));

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
      await db.endSession(this.#session!.id);
      timer.stop();
      await this.#route();
    });
  }
}

customElements.define('tg-app-shell', AppShell);
