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
import type { ExerciseCatalog } from '../exercises.js';

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
`);

export class Equipment extends HTMLElement {
  #root: ShadowRoot;
  #catalog?: ExerciseCatalog;
  /** undefined until loaded; then undefined means unconfigured. See the class remarks. */
  #owned: string[] | undefined;
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
    this.#owned = (await db.getSettings()).ownedAttachments;
    this.#loaded = true;
    this.#render();
  }

  #render(): void {
    if (!this.#catalog || !this.#loaded) return;

    const attachments = this.#catalog.attachments;
    const owned = new Set(this.#owned ?? attachments);
    const available = this.#catalog.available(this.#owned).length;

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
        <ul>
          ${attachments
            .map(
              (attachment, index) => `
                <li>
                  <label>
                    <input type="checkbox" id="att-${index}" data-attachment="${attachment}"
                           ${owned.has(attachment) ? 'checked' : ''} />
                    ${attachment}
                  </label>
                </li>`,
            )
            .join('')}
        </ul>
      </details>
    `;

    for (const input of this.#root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) {
      input.addEventListener('change', () => void this.#save());
    }
  }

  async #save(): Promise<void> {
    const owned = [...this.#root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
      .filter((input) => input.checked)
      .map((input) => input.dataset['attachment']!);

    this.#owned = owned;
    await db.saveSettings({ ownedAttachments: owned });

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
