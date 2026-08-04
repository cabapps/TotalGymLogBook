/**
 * <tg-update-banner>
 *
 * "A new version is ready" -- the visible half of src/client/src/updates.ts.
 *
 * Deliberately a prompt and not an automatic reload. The rep count in the stepper lives in
 * memory until the set is logged, and swapping the page out from under someone between their
 * eighth and ninth rep loses it. Dismissing is safe: the worker stays waiting and the banner
 * comes back on the next foreground check.
 */

import { UPDATE_READY_EVENT, applyUpdate, isUpdateReady } from '../updates.js';

import { ios } from './theme.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: none; }
  /* The host itself is the fixed bar. Putting position:fixed on an inner div instead leaves
     the host with a zero-height box, which reads as "not visible" to anything measuring it --
     assistive tech and e2e checks included. */
  :host([open]) { display: block; position: fixed; left: 0; right: 0; bottom: 0; z-index: 900; }
  /* A bottom bar in the same blurred material as the nav bar, so the two read as one chrome. */
  .bar {
    display: flex; align-items: center; gap: .75rem; flex-wrap: wrap;
    padding: .75rem var(--gutter) calc(.75rem + env(safe-area-inset-bottom));
    background: var(--material);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    backdrop-filter: saturate(180%) blur(20px);
    border-top: var(--hairline) solid var(--separator);
  }
  p { margin: 0; flex: 1 1 12rem; font-size: var(--text-subhead);
      color: var(--fg); line-height: 1.4; }
  button {
    min-height: 2.25rem; padding: 0 .9rem;
    border: 0; border-radius: var(--radius-small);
    background: var(--fill); color: var(--accent);
    font-size: var(--text-subhead); font-weight: 500;
  }
  button.primary {
    width: auto; min-height: 2.25rem; margin-top: 0;
    background: var(--accent); color: #fff;
  }
`);

export class UpdateBanner extends HTMLElement {
  #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [ios, styles];
  }

  connectedCallback(): void {
    window.addEventListener(UPDATE_READY_EVENT, this.#onReady);

    // The worker may have announced itself before this element upgraded -- registration is
    // kicked off from main.ts, and a worker already parked in 'waiting' is reported
    // immediately. Ask rather than rely on catching the event.
    if (isUpdateReady()) this.#onReady();
  }

  disconnectedCallback(): void {
    window.removeEventListener(UPDATE_READY_EVENT, this.#onReady);
  }

  #onReady = (): void => {
    this.#render();
    this.setAttribute('open', '');
  };

  #render(): void {
    this.#root.innerHTML = `
      <div class="bar" role="status">
        <p id="message">A new version of Total Gym Logbook is ready.</p>
        <button id="later">Later</button>
        <button class="primary" id="update">Update</button>
      </div>
    `;

    this.#root.getElementById('later')!.addEventListener('click', () => {
      this.removeAttribute('open');
    });

    this.#root.getElementById('update')!.addEventListener('click', () => {
      // The page reloads once the new worker takes control, which is not instant on a phone.
      // Say so, or the tap reads as having done nothing.
      this.#root.getElementById('message')!.textContent = 'Updating…';
      (this.#root.getElementById('update') as HTMLButtonElement).disabled = true;
      applyUpdate();
    });
  }
}

customElements.define('tg-update-banner', UpdateBanner);
