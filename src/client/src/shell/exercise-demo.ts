/**
 * <tg-exercise-demo>
 *
 * The element around the drawing in demo.ts. Everything worth testing lives there; this owns the
 * shadow root, the stylesheet and the caption.
 */

import type { Exercise } from '../exercises.js';
import { demoCaption, demoSvg } from '../demo.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; }
  figure { margin: .5rem 0 0; }
  svg { width: 100%; height: auto; display: block; border-radius: .5rem;
        background: var(--bg); border: 1px solid var(--border); }
  figcaption { font-size: .7rem; color: var(--muted); margin-top: .3rem; line-height: 1.4; }
  .rail { stroke: var(--border); stroke-width: 3; stroke-linecap: round; }
  .tower { stroke: var(--border); stroke-width: 3; stroke-linecap: round; }
  .cable { stroke: var(--accent); stroke-width: 1.5; fill: none; opacity: .8; }
  .board { fill: var(--surface); stroke: var(--muted); stroke-width: 1.5; }
  .figure { stroke: var(--fg); stroke-width: 2.5; stroke-linecap: round; fill: none; }
  .head { fill: var(--fg); stroke: none; }
  .accessory { stroke: var(--accent); stroke-width: 3; stroke-linecap: round; }

  /* One clock drives the whole drawing, so the board and the limb cannot drift apart. */
  .anim { animation: work 3s ease-in-out infinite alternate; }

  @keyframes work { from { transform: translate(0, 0); } to { transform: var(--travel); } }

  /* A demo that moves without being asked is worse than none for anyone who set this. */
  @media (prefers-reduced-motion: reduce) {
    .anim { animation: none; transform: var(--travel); }
  }
`);

export class ExerciseDemo extends HTMLElement {
  #root: ShadowRoot;
  #exercise: Exercise | undefined;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
  }

  show(exercise: Exercise): void {
    this.#exercise = exercise;
    this.#render();
  }

  clear(): void {
    this.#exercise = undefined;
    this.#root.innerHTML = '';
  }

  #render(): void {
    const exercise = this.#exercise;
    if (!exercise) return;

    this.#root.innerHTML = `
      <figure>
        ${demoSvg(exercise)}
        <figcaption id="caption">
          ${demoCaption(exercise)}
          <br />A sketch of where you go and what moves &mdash; not a form guide.
        </figcaption>
      </figure>
    `;
  }
}

customElements.define('tg-exercise-demo', ExerciseDemo);
