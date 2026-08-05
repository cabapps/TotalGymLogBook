/**
 * <tg-tab-bar>
 *
 * The bottom tab bar. Three destinations, fixed, in the same blurred material as the nav bar.
 *
 * It exists to get the settings off the logging screen. Equipment and "add your own exercise" are
 * configured once and then never again, and they were sitting between the trainee and the Finish
 * button on the one screen that has to stay fast (docs/adr/0003). A tab bar is how iOS separates
 * "the thing you came here to do" from "the things you set up once".
 *
 * PANES ARE HIDDEN, NEVER REBUILT. Switching tabs toggles [hidden] on sections the shell has
 * already rendered, because the set logger holds a rep count in memory that is not in IndexedDB
 * yet -- rebuilding it to change tabs would throw away the set the trainee is in the middle of.
 */

import { ios } from './theme.js';

export interface Tab {
  readonly id: string;
  readonly label: string;
}

/**
 * Glyphs as inline strokes rather than an icon font.
 *
 * SF Symbols cannot be shipped and a webfont would be a network request the CSP blocks and a
 * round trip the first paint cannot afford. These are a few hundred bytes and inherit
 * currentColor, so the tint state costs nothing.
 */
const GLYPHS: Record<string, string> = {
  workout:
    '<path d="M4 9v6M20 9v6M7 7v10M17 7v10M7 12h10" />',
  coach:
    '<path d="M4 19h16M6 15l4-5 3.5 3L19 6" />',
  settings:
    '<path d="M4 8h10M18 8h2M4 16h4M12 16h8" /><circle cx="16" cy="8" r="2.2" /><circle cx="10" cy="16" r="2.2" />',
};

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host {
    display: block;
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 800;
    background: var(--material);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    backdrop-filter: saturate(180%) blur(20px);
    border-top: var(--hairline) solid var(--separator);
    padding-bottom: env(safe-area-inset-bottom);
  }

  nav {
    display: flex; max-width: 34rem; margin: 0 auto;
  }

  button {
    flex: 1;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: .1rem;
    /* 49pt is the real UITabBar height, and every tab is a full-width target inside it. */
    min-height: 3.0625rem; padding: .3rem 0;
    border: 0; background: none;
    color: var(--muted);
    font-size: var(--text-caption2); font-weight: 500; letter-spacing: .01em;
  }
  /* The whole bar is chrome: dimming a tab on touch is iOS's own feedback and the only one. */
  button:active { opacity: .45; }
  @media (hover: hover) { button:hover { opacity: 1; } }

  button[aria-selected="true"] { color: var(--accent); }

  svg {
    width: 1.625rem; height: 1.625rem;
    fill: none; stroke: currentColor; stroke-width: 1.7;
    stroke-linecap: round; stroke-linejoin: round;
  }
`);

export class TabBar extends HTMLElement {
  #root: ShadowRoot;
  #tabs: readonly Tab[] = [];
  #active = '';

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [ios, styles];
  }

  configure(tabs: readonly Tab[], active: string): void {
    this.#tabs = tabs;
    this.#active = active;
    this.#render();
  }

  get active(): string {
    return this.#active;
  }

  /** Selects a tab without firing the event, for when the shell moves tabs itself. */
  select(id: string): void {
    if (!this.#tabs.some((t) => t.id === id)) return;

    this.#active = id;
    for (const button of this.#root.querySelectorAll('button')) {
      button.setAttribute('aria-selected', String(button.dataset['tab'] === id));
    }
  }

  #render(): void {
    this.#root.innerHTML = `
      <nav role="tablist">
        ${this.#tabs
          .map(
            (tab) => `
              <button role="tab" data-tab="${tab.id}" id="tab-${tab.id}"
                      aria-selected="${tab.id === this.#active}">
                <svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS[tab.id] ?? ''}</svg>
                ${tab.label}
              </button>`,
          )
          .join('')}
      </nav>
    `;

    for (const button of this.#root.querySelectorAll('button')) {
      button.addEventListener('click', () => {
        const id = button.dataset['tab']!;
        if (id === this.#active) return;

        this.select(id);
        this.dispatchEvent(
          new CustomEvent('tab-selected', { bubbles: true, composed: true, detail: { id } }),
        );
      });
    }
  }
}

customElements.define('tg-tab-bar', TabBar);
