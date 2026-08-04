/**
 * <tg-exercise-editor>
 *
 * Adding a movement the built-in catalog does not have.
 *
 * The dangerous field is `usesPulley`, and it is dangerous in a way the trainee cannot see: a
 * cable movement is halved by the pulley (docs/adr/0004), so getting it wrong doubles or halves
 * every load ever recorded against the exercise, silently and permanently. So it is asked as a
 * concrete physical question -- "are you holding the cable handles?" -- rather than as jargon,
 * and the resulting load is previewed live so a wrong answer is visible before it is saved.
 */

import * as db from '../db/repository.js';
import { computeResistance, type RailProfile } from '../resistance.js';
import type { ExerciseCatalog } from '../exercises.js';
import type { CustomExerciseRecord } from '../db/schema.js';

/** Matches TotalGymLogBook.Domain.Training.MuscleGroup. */
const MUSCLES = [
  'Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps',
  'Quadriceps', 'Hamstrings', 'Adductors', 'Glutes', 'Calves', 'Core',
] as const;

const POSITIONS = [
  { label: 'Lying on the board', fraction: 1.0 },
  { label: 'Sitting up', fraction: 0.85 },
  { label: 'Kneeling', fraction: 0.7 },
] as const;

import { ios } from './theme.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; margin-top: var(--group-gap); }
  details {
    background: var(--surface); border-radius: var(--radius-card);
    padding: 0 var(--gutter) .8rem;
  }
  details:not([open]) { padding-bottom: 0; }
  summary {
    display: flex; align-items: center; gap: .4rem;
    min-height: var(--tap); cursor: pointer;
    font-size: var(--text-body); color: var(--fg);
    list-style: none;
    -webkit-tap-highlight-color: transparent;
  }
  summary::-webkit-details-marker { display: none; }
  summary::after {
    content: ''; flex: 0 0 .5rem; height: .8125rem; margin-left: auto;
    background: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='13' fill='none' stroke='%238e8e93' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M1.5 1.5l5 5-5 5'/%3E%3C/svg%3E") no-repeat center;
    transition: transform .2s ease;
  }
  details[open] summary::after { transform: rotate(90deg); }

  textarea { resize: vertical; min-height: 3.5rem; }
  .row { display: flex; gap: .6rem; }
  .row > * { flex: 1; }

  /* Muscle involvement: tinted capsules that fill in as they are promoted. */
  .muscles { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .35rem; }
  .muscles button {
    min-height: 2rem; padding: 0 .7rem;
    border: 0; border-radius: 999px;
    background: var(--fill); color: var(--muted);
    font-size: var(--text-subhead); font-weight: 500;
  }
  .muscles button[data-state="direct"] { background: var(--accent); color: #fff; }
  .muscles button[data-state="indirect"] { background: var(--accent-tint); color: var(--accent); }

  .preview {
    margin-top: .8rem; padding: .6rem .7rem; border-radius: var(--radius-small);
    background: var(--fill); font-size: var(--text-footnote); color: var(--muted);
  }
  .preview b { font-family: var(--font-rounded); font-size: var(--text-title3);
               font-weight: 700; color: var(--fg); font-variant-numeric: tabular-nums; }
  .hint { font-size: var(--text-caption); color: var(--muted); margin: .3rem 0 0;
          line-height: 1.4; }

  .actions { display: flex; gap: .5rem; margin-top: 1rem; }
  button.save {
    min-height: 2.25rem; padding: 0 1rem;
    border: 0; border-radius: var(--radius-small);
    background: var(--accent); color: #fff;
    font-size: var(--text-subhead); font-weight: 600;
  }
  button.save:disabled { background: var(--fill-strong); color: var(--faint); opacity: 1; }

  .mine { list-style: none; margin: .9rem 0 0; padding: 0; }
  .mine li { display: flex; align-items: center; justify-content: space-between; gap: .5rem;
             min-height: var(--tap); padding: .2rem 0;
             border-top: var(--hairline) solid var(--separator);
             font-size: var(--text-body); }
  .mine button {
    min-height: 2rem; padding: 0 .6rem;
    border: 0; border-radius: var(--radius-small);
    background: var(--fill); color: var(--danger);
    font-size: var(--text-subhead);
  }
  .result { font-size: var(--text-footnote); color: var(--system-green); margin-top: .5rem; }
`);

type Involvement = 'none' | 'direct' | 'indirect';

export class ExerciseEditor extends HTMLElement {
  #root: ShadowRoot;
  #catalog?: ExerciseCatalog;
  #profile?: RailProfile;
  #bodyweightLb = 180;
  #mine: CustomExerciseRecord[] = [];
  #muscles = new Map<string, Involvement>();
  #message = '';

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [ios, styles];
  }

  configure(opts: { catalog: ExerciseCatalog; profile: RailProfile; bodyweightLb: number }): void {
    this.#catalog = opts.catalog;
    this.#profile = opts.profile;
    this.#bodyweightLb = opts.bodyweightLb;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    this.#mine = await db.listCustomExercises();
    this.#render();
  }

  #render(): void {
    if (!this.#catalog) return;

    const categories = [...new Set(this.#catalog.all.map((e) => e.category))];

    this.#root.innerHTML = `
      <details id="panel">
        <summary>Add your own exercise</summary>

        <label for="name">Name</label>
        <input id="name" type="text" maxlength="60" placeholder="e.g. Kneeling Cable Crunch" />

        <div class="row">
          <div>
            <label for="category">Group it under</label>
            <select id="category">
              ${categories.map((c) => `<option value="${c}">${c}</option>`).join('')}
            </select>
          </div>
          <div>
            <label for="position">Your position</label>
            <select id="position">
              ${POSITIONS.map((p, i) => `<option value="${i}">${p.label}</option>`).join('')}
            </select>
          </div>
        </div>

        <label for="pulley">Are you holding the cable handles?</label>
        <select id="pulley">
          <option value="yes">Yes &mdash; pulling the cable</option>
          <option value="no">No &mdash; pushing straight off the board</option>
        </select>
        <p class="hint">
          This one matters more than it looks: the cable halves the load, so getting it wrong
          doubles or halves every weight recorded for this exercise. Check the number below
          against what the movement actually feels like.
        </p>

        <label>Which muscles does it work? Tap once for main, twice for a bit</label>
        <div class="muscles" id="muscles">
          ${MUSCLES.map(
            (m) => `<button type="button" data-muscle="${m}" data-state="none">${m}</button>`,
          ).join('')}
        </div>

        <label for="stretch">Is it hardest at the stretched end?</label>
        <select id="stretch">
          <option value="even">Hard the whole way through</option>
          <option value="lengthened">Hardest stretched &mdash; like the bottom of a fly</option>
          <option value="shortened">Hardest squeezed &mdash; like the top of a curl</option>
        </select>
        <p class="hint">
          Movements that are hardest with the muscle long build it fastest, so the program
          builder offers those first. Asked as what the set feels like, because that is the part
          you can actually answer.
        </p>

        <label for="cue">How do you do it? (optional)</label>
        <textarea id="cue" maxlength="200" placeholder="A line to remind you of the setup."></textarea>

        <div class="preview">
          At level 8 this would be <b id="preview">—</b> lb
          <span id="previewNote"></span>
        </div>

        ${this.#message ? `<p class="result" id="result">${this.#message}</p>` : ''}

        <div class="actions">
          <button class="save" id="save" disabled>Add exercise</button>
        </div>

        ${
          this.#mine.length > 0
            ? `<ul class="mine">
                 ${this.#mine
                   .map(
                     (e) => `<li><span>${e.name}</span>
                       <button data-remove="${e.id}">Remove</button></li>`,
                   )
                   .join('')}
               </ul>`
            : ''
        }
      </details>
    `;

    const on = (id: string, event: string, fn: () => void) =>
      this.#root.getElementById(id)!.addEventListener(event, fn);

    on('name', 'input', () => this.#update());
    on('position', 'change', () => this.#update());
    on('pulley', 'change', () => this.#update());
    on('save', 'click', () => void this.#save());

    for (const button of this.#root.querySelectorAll<HTMLButtonElement>('[data-muscle]')) {
      button.addEventListener('click', () => {
        const muscle = button.dataset['muscle']!;
        const next: Involvement =
          this.#muscles.get(muscle) === 'direct'
            ? 'indirect'
            : this.#muscles.get(muscle) === 'indirect'
              ? 'none'
              : 'direct';

        this.#muscles.set(muscle, next);
        button.dataset['state'] = next;
        this.#update();
      });
    }

    for (const button of this.#root.querySelectorAll<HTMLButtonElement>('[data-remove]')) {
      button.addEventListener('click', async () => {
        await db.deleteCustomExercise(button.dataset['remove']!);
        this.#say('Removed. Sets you already logged against it are untouched.');
        await this.refresh();
        this.#announce();
      });
    }

    this.#update();
  }

  #read() {
    const value = (id: string) =>
      (this.#root.getElementById(id) as HTMLInputElement | HTMLSelectElement).value;

    return {
      name: value('name').trim(),
      category: value('category'),
      bodyFraction: POSITIONS[Number(value('position'))]!.fraction,
      usesPulley: value('pulley') === 'yes',
      peakTension: value('stretch') as 'lengthened' | 'even' | 'shortened',
      cue: (this.#root.getElementById('cue') as HTMLTextAreaElement).value.trim(),
    };
  }

  #update(): void {
    const form = this.#read();
    const chosen = [...this.#muscles].filter(([, state]) => state !== 'none');

    // The preview is the safety net on usesPulley. A number that is obviously double what the
    // movement feels like is the only signal a trainee has that they answered wrong.
    const lb = computeResistance(this.#profile!, {
      bodyweightLb: this.#bodyweightLb,
      level: 8,
      usesPulley: form.usesPulley,
      bodyFraction: form.bodyFraction,
      vestLb: 0,
      barLb: 0,
    });

    this.#root.getElementById('preview')!.textContent = lb.toFixed(1);
    this.#root.getElementById('previewNote')!.textContent = form.usesPulley
      ? '· halved by the cable'
      : '';

    (this.#root.getElementById('save') as HTMLButtonElement).disabled =
      form.name.length === 0 || chosen.length === 0;
  }

  async #save(): Promise<void> {
    const form = this.#read();
    const muscles = [...this.#muscles]
      .filter(([, state]) => state !== 'none')
      .map(([muscle, state]) => ({ muscle, fraction: state === 'direct' ? 1.0 : 0.5 }));

    await db.saveCustomExercise({
      ...form,
      kind: 'strength',
      attachment: null,
      cue: form.cue || 'Your own movement.',
      muscles,
    });

    this.#muscles.clear();
    this.#say(`Added ${form.name}. It's in the exercise list now.`);
    await this.refresh();
    this.#announce();
  }

  #say(message: string): void {
    this.#message = message;
  }

  #announce(): void {
    this.dispatchEvent(new CustomEvent('exercises-changed', { bubbles: true, composed: true }));
  }
}

customElements.define('tg-exercise-editor', ExerciseEditor);
