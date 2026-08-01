/**
 * <tg-program-editor>
 *
 * Building or changing a program, with the weekly volume moving as you do it.
 *
 * WHY THE NUMBERS ARE HERE AND NOT IN THE COACH. The coach can already tell you a finished
 * program leaves your biceps short. That is the wrong moment: by then you have committed, and
 * the fix means coming back and editing. Showing sets-per-muscle while the trainee is choosing
 * turns the effective dose from a verdict into a dial they can see themselves moving.
 *
 * NOTHING HERE BLOCKS. A program that ignores a muscle group saves exactly like any other; the
 * gap is stated and the decision stays the trainee's. Plenty of real programs skip a muscle on
 * purpose, and an app that refuses to save one is an app that is wrong about training more often
 * than the trainee is.
 *
 * Instant tier, because this writes (docs/adr/0003): IndexedDB is the shell's, and the editor
 * has to work whether or not .NET ever boots.
 */

import * as db from '../db/repository.js';
import type { ExerciseCatalog, Exercise } from '../exercises.js';
import type { PlannedExercise, ProgramRecord, ProgramSession } from '../db/schema.js';
import { MINIMUM_EFFECTIVE_DOSE, MUSCLES, plannedWeeklySets } from '../programs.js';
import { explain, score, type ProgramEmphasis } from '../emphasis.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; margin-bottom: .75rem; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: .75rem; padding: .9rem 1rem;
  }
  h3 { font-size: .95rem; margin: 0 0 .5rem; }
  h4 { font-size: .78rem; margin: .9rem 0 .3rem; }
  p { margin: .35rem 0 .5rem; font-size: .75rem; color: var(--muted); line-height: 1.45; }
  label { display: block; font-size: .7rem; color: var(--muted); margin: .6rem 0 .2rem; }
  input[type=text], select {
    width: 100%; padding: .45rem; font: inherit; font-size: .8125rem; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  }
  ul, ol { list-style: none; margin: 0; padding: 0; }
  li.ex {
    display: flex; align-items: center; gap: .4rem;
    padding: .35rem 0; border-top: 1px solid var(--border); font-size: .8125rem;
  }
  li.ex .name { flex: 1; }
  li.ex .tag { font-size: .62rem; text-transform: uppercase; letter-spacing: .04em;
               color: var(--accent); border: 1px solid var(--accent);
               border-radius: .3rem; padding: 0 .25rem; }
  .step, .kill {
    font: inherit; font-size: .8125rem; min-width: 1.7rem; padding: .1rem .4rem;
    border: 1px solid var(--border); border-radius: .4rem;
    background: var(--bg); color: var(--fg); cursor: pointer;
  }
  .count { min-width: 1.4rem; text-align: center; font-variant-numeric: tabular-nums; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .7rem; }
  button.action {
    font: inherit; font-size: .75rem; padding: .35rem .7rem; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--muted); cursor: pointer;
  }
  button.action.primary {
    background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600;
  }
  .session { border-top: 1px solid var(--border); padding-top: .5rem; margin-top: .8rem; }
  .session .head { display: flex; align-items: center; gap: .4rem; }
  .session .head input { flex: 1; }
  ul.volume { margin: .3rem 0 0; font-size: .75rem; }
  ul.volume li { display: flex; align-items: center; gap: .5rem; padding: .16rem 0; }
  ul.volume .muscle { flex: 0 0 5.5rem; }
  ul.volume .bar { flex: 1; height: .45rem; border-radius: 999px; background: var(--border);
                   overflow: hidden; }
  ul.volume .bar span { display: block; height: 100%; background: var(--accent); }
  ul.volume li.short .bar span { background: #d97706; }
  ul.volume li.none .bar span { background: transparent; }
  ul.volume .sets { flex: 0 0 2.2rem; text-align: right; color: var(--muted);
                    font-variant-numeric: tabular-nums; }
  .verdict { font-size: .75rem; line-height: 1.5; margin: .5rem 0 0;
             padding: .5rem .6rem; border-radius: .5rem;
             background: var(--bg); border: 1px solid var(--border); color: var(--muted); }
`);

/** A blank session, so a new program starts as something you can add to rather than a form. */
function emptySession(index: number): ProgramSession {
  return { id: `s${index}-${Date.now().toString(36)}`, name: `Session ${index}`, exercises: [] };
}

export class ProgramEditor extends HTMLElement {
  #root: ShadowRoot;
  #catalog?: ExerciseCatalog;
  #emphasis: ProgramEmphasis = 'lengthened';
  #owned: readonly string[] | undefined;
  #name = '';
  #sessions: ProgramSession[] = [];
  /** The program being edited, or undefined when building a new one. */
  #editing: string | undefined;
  #open = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
  }

  configure(opts: {
    catalog: ExerciseCatalog;
    emphasis: ProgramEmphasis;
    ownedAttachments?: readonly string[];
  }): void {
    this.#catalog = opts.catalog;
    this.#emphasis = opts.emphasis;
    this.#owned = opts.ownedAttachments;
    if (this.#open) this.#render();
  }

  /** Opens on an existing program, or on a blank one when given nothing. */
  edit(program?: ProgramRecord): void {
    this.#editing = program?.id;
    this.#name = program?.name ?? 'My program';
    this.#sessions = program
      ? program.sessions.map((s) => ({ ...s, exercises: s.exercises.map((e) => ({ ...e })) }))
      : [emptySession(1)];

    this.#open = true;
    this.#render();
  }

  close(): void {
    this.#open = false;
    this.#root.innerHTML = '';
  }

  get isOpen(): boolean {
    return this.#open;
  }

  // ---------------------------------------------------------------- rendering

  #render(): void {
    if (!this.#catalog || !this.#open) return;

    this.#root.innerHTML = `
      <div class="card">
        <h3>${this.#editing ? 'Edit your program' : 'Build a program'}</h3>

        <label for="name">Name</label>
        <input type="text" id="name" maxlength="60" value="${this.#name.replace(/"/g, '&quot;')}" />

        ${this.#sessions.map((session, index) => this.#renderSession(session, index)).join('')}

        <div class="row">
          <button class="action" id="add-session">Add a session</button>
        </div>

        <h4>Sets a rotation</h4>
        <p>${explain(this.#emphasis)}</p>
        ${this.#renderVolume()}

        <div class="row">
          <button class="action primary" id="save">Save program</button>
          <button class="action" id="cancel">Cancel</button>
        </div>
      </div>
    `;

    this.#root.getElementById('name')!.addEventListener('input', (event) => {
      this.#name = (event.target as HTMLInputElement).value;
    });

    this.#root.getElementById('add-session')!.addEventListener('click', () => {
      this.#sessions.push(emptySession(this.#sessions.length + 1));
      this.#render();
    });

    this.#root.getElementById('save')!.addEventListener('click', () => void this.#save());
    this.#root.getElementById('cancel')!.addEventListener('click', () => {
      this.close();
      this.dispatchEvent(new CustomEvent('editor-closed', { bubbles: true, composed: true }));
    });

    this.#wireSessions();
  }

  #renderSession(session: ProgramSession, index: number): string {
    const options = this.#pickable()
      .map((e) => `<option value="${e.id}">${e.name}${this.#badge(e)}</option>`)
      .join('');

    return `
      <div class="session" data-session="${index}">
        <div class="head">
          <input type="text" id="sname-${index}" maxlength="40" value="${session.name}" />
          ${this.#sessions.length > 1
            ? `<button class="kill" id="skill-${index}" title="Remove session">&times;</button>`
            : ''}
        </div>

        <ul id="exlist-${index}">
          ${session.exercises.map((planned, row) => this.#renderExercise(planned, index, row)).join('')}
        </ul>

        <label for="add-${index}">Add a movement</label>
        <select id="add-${index}">
          <option value="">Choose&hellip;</option>
          ${options}
        </select>
      </div>
    `;
  }

  #renderExercise(planned: PlannedExercise, session: number, row: number): string {
    const exercise = this.#catalog!.tryGet(planned.exerciseId);

    return `
      <li class="ex">
        <span class="name">${exercise?.name ?? planned.exerciseId}</span>
        ${exercise?.peakTension === 'lengthened' ? '<span class="tag">stretch</span>' : ''}
        <button class="step" id="minus-${session}-${row}">&minus;</button>
        <span class="count" id="sets-${session}-${row}">${planned.sets}</span>
        <button class="step" id="plus-${session}-${row}">+</button>
        <button class="kill" id="drop-${session}-${row}">&times;</button>
      </li>
    `;
  }

  /**
   * Movements to offer, best first for what the trainee is training for.
   *
   * Ordered rather than filtered: an exercise that scores badly for this emphasis is still a
   * perfectly good exercise, and the trainee may have a reason for it the app cannot see.
   */
  #pickable(): readonly Exercise[] {
    return this.#catalog!.available(this.#owned)
      .filter((e) => e.kind === 'strength')
      .slice()
      .sort((a, b) => score(this.#emphasis, b) - score(this.#emphasis, a) || a.name.localeCompare(b.name));
  }

  #badge(exercise: Exercise): string {
    if (this.#emphasis === 'lengthened' && exercise.peakTension === 'lengthened') return ' ★';
    return '';
  }

  #renderVolume(): string {
    const volume = plannedWeeklySets(this.#sessions, this.#catalog!);
    const untrained = MUSCLES.filter((m) => (volume.get(m) ?? 0) <= 0);
    const short = MUSCLES.filter((m) => {
      const sets = volume.get(m) ?? 0;
      return sets > 0 && sets < MINIMUM_EFFECTIVE_DOSE;
    });

    const rows = MUSCLES.map((muscle) => {
      const sets = volume.get(muscle) ?? 0;
      const width = Math.min(100, (100 * sets) / (MINIMUM_EFFECTIVE_DOSE * 2));
      const state = sets <= 0 ? 'none' : sets < MINIMUM_EFFECTIVE_DOSE ? 'short' : '';

      return `
        <li class="${state}">
          <span class="muscle">${muscle}</span>
          <span class="bar"><span style="width:${width}%"></span></span>
          <span class="sets">${sets % 1 === 0 ? sets : sets.toFixed(1)}</span>
        </li>`;
    }).join('');

    return `
      <ul class="volume" id="volume">${rows}</ul>
      <p class="verdict" id="verdict">${this.#verdict(short, untrained)}</p>
    `;
  }

  /**
   * What the numbers add up to, in a sentence. Never an instruction and never a blocker: a gap
   * is reported the same way whether the trainee meant it or not, because the app cannot tell
   * the difference and the trainee can.
   */
  #verdict(short: readonly string[], untrained: readonly string[]): string {
    const parts: string[] = [];

    if (short.length > 0) {
      parts.push(
        `${short.join(', ')} ${short.length === 1 ? 'is' : 'are'} under ` +
          `${MINIMUM_EFFECTIVE_DOSE} sets a rotation, which is where growth starts. ` +
          'Another set or two of something that works ' +
          `${short.length === 1 ? 'it' : 'them'} would cover it.`,
      );
    }

    if (untrained.length > 0) {
      parts.push(`Nothing in here trains ${untrained.join(', ')} — fine if that is deliberate.`);
    }

    if (parts.length === 0) {
      parts.push(
        `Everything this program trains gets at least ${MINIMUM_EFFECTIVE_DOSE} sets a rotation.`,
      );
    }

    return parts.join(' ');
  }

  // ---------------------------------------------------------------- wiring

  #wireSessions(): void {
    const on = (id: string, event: string, fn: () => void) =>
      this.#root.getElementById(id)?.addEventListener(event, fn);

    for (const [index, session] of this.#sessions.entries()) {
      on(`sname-${index}`, 'input', () => {
        session.name = (this.#root.getElementById(`sname-${index}`) as HTMLInputElement).value;
      });

      on(`skill-${index}`, 'click', () => {
        this.#sessions.splice(index, 1);
        this.#render();
      });

      on(`add-${index}`, 'change', () => {
        const select = this.#root.getElementById(`add-${index}`) as HTMLSelectElement;
        if (!select.value) return;

        // Adding a movement already in the session bumps its sets instead of listing it twice,
        // which is what the trainee meant and keeps the volume honest either way.
        const existing = session.exercises.find((e) => e.exerciseId === select.value);
        if (existing) existing.sets += 1;
        else session.exercises.push({ exerciseId: select.value, sets: 3 });

        this.#render();
      });

      for (const [row, planned] of session.exercises.entries()) {
        on(`plus-${index}-${row}`, 'click', () => {
          planned.sets = Math.min(10, planned.sets + 1);
          this.#render();
        });
        on(`minus-${index}-${row}`, 'click', () => {
          planned.sets = Math.max(1, planned.sets - 1);
          this.#render();
        });
        on(`drop-${index}-${row}`, 'click', () => {
          session.exercises.splice(row, 1);
          this.#render();
        });
      }
    }
  }

  async #save(): Promise<void> {
    // Empty sessions are dropped rather than refused: a trainee who adds a session and changes
    // their mind should not have to find the remove button to get past the save.
    const sessions = this.#sessions.filter((s) => s.exercises.length > 0);

    await db.saveProgram({
      ...(this.#editing !== undefined && { id: this.#editing }),
      name: this.#name.trim() || 'My program',
      description: 'Your own program.',
      sessions,
      isActive: true,
    });

    this.close();
    this.dispatchEvent(new CustomEvent('program-changed', { bubbles: true, composed: true }));
  }
}

customElements.define('tg-program-editor', ProgramEditor);
