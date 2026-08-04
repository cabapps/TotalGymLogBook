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

import { ios } from './theme.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; margin-top: var(--group-gap); }

  /* A disclosure row on a card: the Settings idiom, right down to the chevron that turns. */
  details {
    background: var(--surface); border-radius: var(--radius-card);
    padding: 0 var(--gutter);
  }
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

  p { margin: 0 0 .6rem; font-size: var(--text-footnote); }
  ul { list-style: none; margin: 0 0 .5rem; padding: 0; }

  /* Label leading, switch trailing. A checkbox in front of the name is a form; a switch at the
     end of the row is a setting, and this is a setting. */
  li { border-top: var(--hairline) solid var(--separator); }
  label {
    display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    min-height: var(--tap); margin: 0;
    font-size: var(--text-body); color: var(--fg); cursor: pointer;
  }
  .text { display: flex; flex-direction: column; gap: .1rem; padding: .35rem 0; }
  .note { font-size: var(--text-footnote); color: var(--muted); line-height: 1.35; }
  .count { color: var(--muted); font-size: var(--text-footnote); }

  h4 { font-size: var(--text-footnote); font-weight: 400; letter-spacing: .04em;
       text-transform: uppercase; color: var(--muted); margin: .9rem 0 .2rem; }
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
    this.#root.adoptedStyleSheets = [ios, styles];
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
          <span class="text">
            ${accessory.name}
            ${accessory.note ? `<span class="note">${accessory.note}</span>` : ''}
          </span>
          <input type="checkbox" id="att-${accessory.id}" data-attachment="${accessory.id}"
                 ${checked ? 'checked' : ''} />
        </label>
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
