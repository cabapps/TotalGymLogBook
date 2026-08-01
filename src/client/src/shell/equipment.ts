/**
 * <tg-equipment>
 *
 * Which accessories the trainee owns. Set once, remembered, and used to shorten the exercise
 * picker from eighty-odd movements to the ones they can actually do.
 *
 * Collapsed by default. This is a configuration surface, not part of the logging loop, and the
 * logging loop is the thing that has to stay fast (docs/adr/0003).
 *
 * Unconfigured means "show everything", never "owns nothing". Defaulting to owns-nothing would
 * hide squats from someone who has been logging squats for months, which reads as data loss.
 */

import * as db from '../db/repository.js';
import type { Accessory, ExerciseCatalog } from '../exercises.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; margin-top: .75rem; }
  details {
    background: var(--surface); border: 1px solid var(--border); border-radius: .75rem;
    padding: .6rem .9rem;
  }
  summary { cursor: pointer; font-size: .8125rem; color: var(--muted); }
  summary::marker { color: var(--muted); }
  p { margin: .5rem 0 .6rem; font-size: .75rem; color: var(--muted); line-height: 1.45; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: .3rem 0; }
  label { display: flex; align-items: center; gap: .5rem; font-size: .8125rem; cursor: pointer; }
  input[type=checkbox] { width: 1.05rem; height: 1.05rem; accent-color: var(--accent); }
  .count { color: var(--muted); font-size: .7rem; margin-left: .25rem; }
  h4 { font-size: .7rem; font-weight: 600; color: var(--muted); text-transform: uppercase;
       letter-spacing: .04em; margin: .8rem 0 .1rem; }
  h4:first-of-type { margin-top: .2rem; }
  .note { display: block; font-size: .7rem; color: var(--muted); line-height: 1.4;
          margin: .05rem 0 0 1.55rem; }
`);

export class Equipment extends HTMLElement {
  #root: ShadowRoot;
  #catalog?: ExerciseCatalog;
  /** undefined until loaded; then undefined means unconfigured. See the class remarks. */
  #owned: readonly string[] | undefined;
  #loaded = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
  }

  configure(opts: { catalog: ExerciseCatalog }): void {
    this.#catalog = opts.catalog;
    void this.#load();
  }

  async #load(): Promise<void> {
    const settings = await db.getSettings();

    // Accessories added since the trainee last answered count as owned until they say
    // otherwise -- see ExerciseCatalog.resolveOwned. Doing it here means the boxes they never
    // saw arrive ticked, matching what the picker is already showing them.
    this.#owned = this.#catalog?.resolveOwned(
      settings.ownedAttachments,
      settings.equipmentVersion,
    );
    this.#loaded = true;
    this.#render();
  }

  #render(): void {
    if (!this.#catalog || !this.#loaded) return;

    const accessories = this.#catalog.accessories;
    const owned = new Set(this.#owned ?? accessories.map((a) => a.id));
    const available = this.#catalog.available(this.#owned).length;

    const group = (heading: string, subset: readonly Accessory[]) =>
      subset.length === 0
        ? ''
        : `<h4>${heading}</h4>
           <ul>${subset.map((a) => this.#item(a, owned.has(a.id))).join('')}</ul>`;

    this.#root.innerHTML = `
      <details>
        <summary id="summary">
          Equipment<span class="count" id="count">
            &middot; ${available} of ${this.#catalog.all.length} exercises shown</span>
        </summary>
        <p>
          Tick what you own. Anything you don't have drops out of the exercise list, here and
          in the coach's suggestions.
        </p>
        ${group('Usually included', accessories.filter((a) => a.common))}
        ${group('Sold separately', accessories.filter((a) => !a.common))}
      </details>
    `;

    for (const input of this.#root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
      input.addEventListener('change', () => void this.#save());
    }
  }

  #item(accessory: Accessory, checked: boolean): string {
    return `
      <li>
        <label>
          <input type="checkbox" id="att-${accessory.id}" data-attachment="${accessory.id}"
                 ${checked ? 'checked' : ''} />
          ${accessory.name}
        </label>
        ${accessory.note ? `<span class="note">${accessory.note}</span>` : ''}
      </li>`;
  }

  async #save(): Promise<void> {
    const owned = [...this.#root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
      .filter((input) => input.checked)
      .map((input) => input.dataset['attachment']!);

    this.#owned = owned;

    // Stamped with the version of the list they were actually shown, so the next release can
    // tell a real "no" from a question that had not been asked yet.
    await db.saveSettings({
      ownedAttachments: owned,
      equipmentVersion: this.#catalog!.accessoryVersion,
    });

    // Only the count needs refreshing; re-rendering would collapse the panel the trainee is
    // still ticking through.
    const available = this.#catalog!.available(owned).length;
    this.#root.getElementById('count')!.textContent =
      ` · ${available} of ${this.#catalog!.all.length} exercises shown`;

    this.dispatchEvent(
      new CustomEvent('equipment-changed', {
        bubbles: true,
        composed: true,
        detail: { ownedAttachments: owned },
      }),
    );
  }
}

customElements.define('tg-equipment', Equipment);
