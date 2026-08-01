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

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; margin-top: .75rem; }
  details {
    background: var(--surface); border: 1px solid var(--border); border-radius: .75rem;
    padding: .6rem .9rem;
  }
  summary { cursor: pointer; font-size: .8125rem; color: var(--muted); }
  label { display: block; font-size: .7rem; color: var(--muted); margin: .7rem 0 .2rem; }
  input, select, textarea {
    width: 100%; padding: .45rem; font: inherit; font-size: .8125rem; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  }
  textarea { resize: vertical; min-height: 2.6rem; }
  .row { display: flex; gap: .6rem; }
  .row > * { flex: 1; }
  .muscles { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .3rem; }
  .muscles button {
    font: inherit; font-size: .7rem; padding: .22rem .5rem; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--muted); cursor: pointer;
  }
  .muscles button[data-state="direct"] {
    background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600;
  }
  .muscles button[data-state="indirect"] { border-color: var(--accent); color: var(--accent); }
  .preview {
    margin-top: .7rem; padding: .5rem .6rem; border-radius: .5rem;
    background: var(--bg); border: 1px solid var(--border); font-size: .75rem; color: var(--muted);
  }
  .preview b { font-size: 1.1rem; color: var(--fg); font-variant-numeric: tabular-nums; }
  .hint { font-size: .7rem; color: var(--muted); margin: .25rem 0 0; line-height: 1.4; }
  .actions { display: flex; gap: .5rem; margin-top: .9rem; }
  button.save {
    font: inherit; font-size: .8125rem; font-weight: 600; padding: .45rem .9rem;
    border: 0; border-radius: .5rem; background: var(--accent); color: #fff; cursor: pointer;
  }
  button.save:disabled { opacity: .5; cursor: default; }
  .mine { list-style: none; margin: .8rem 0 0; padding: 0; }
  .mine li { display: flex; align-items: center; justify-content: space-between; gap: .5rem;
             padding: .35rem 0; border-top: 1px solid var(--border); font-size: .8125rem; }
  .mine button {
    font: inherit; font-size: .7rem; padding: .2rem .5rem; border-radius: .35rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--muted); cursor: pointer;
  }
  .result { font-size: .75rem; color: var(--accent); margin-top: .5rem; }
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
    this.#root.adoptedStyleSheets = [styles];
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
