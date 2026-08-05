/**
 * <tg-exercise-demo>
 *
 * The element around the drawing in demo.ts. Everything worth testing lives there; this owns the
 * shadow root, the stylesheet and the caption.
 */

import type { Exercise } from '../exercises.js';
import { demoCaption, demoSvg } from '../demo.js';

import { ios } from './theme.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  figure { margin: .6rem 0 0; }
  svg { width: 100%; height: auto; display: block; border-radius: var(--radius-field);
        background: var(--fill); }
  figcaption { font-size: var(--text-footnote); color: var(--muted); margin-top: .35rem;
               line-height: 1.4; }
  /* The machine is drawn in systemGray rather than the separator color: a hairline tint that
     reads correctly as a 1px rule is nearly invisible as a 3px stroke on a tinted panel. */
  .rail { stroke: var(--system-gray); stroke-width: 3; stroke-linecap: round; }
  .tower { stroke: var(--system-gray); stroke-width: 3; stroke-linecap: round; }
  .cable { stroke: var(--accent); stroke-width: 1.5; fill: none; opacity: .8; }
  .board { fill: var(--surface); stroke: var(--system-gray); stroke-width: 1.5; }
  .figure { stroke: var(--fg); stroke-width: 2.5; stroke-linecap: round; fill: none; }
  .head { fill: var(--fg); stroke: none; }
  .accessory { stroke: var(--accent); stroke-width: 3; stroke-linecap: round; }

  /* One clock for all three, so the board, the limb and the joint cannot drift out of phase. */
  .anim { animation: work 3s ease-in-out infinite alternate; }
  .limb { animation: swing 3s ease-in-out infinite alternate; }
  .joint { animation: bend 3s ease-in-out infinite alternate; }

  @keyframes work { from { transform: translate(0, 0); } to { transform: var(--travel); } }

  /*
    The limb ROTATES about its joint rather than translating. Its parent group has already
    translated the origin onto the joint, and an SVG element's transform-origin is that origin,
    so this pivots where the shoulder or hip actually is.
  */
  @keyframes swing { from { transform: rotate(0deg); } to { transform: rotate(var(--swing)); } }

  /*
    The elbow or knee, which is the thing a trainee is looking for: a straight stick cannot say
    which joint is supposed to bend, and a curl and a press trace nearly the same arc without it.
    Its own origin is already the joint, so this rotation is relative to the segment above it and
    composes with the swing rather than fighting it.
  */
  @keyframes bend {
    from { transform: rotate(var(--bend-from, 0deg)); }
    to { transform: rotate(var(--bend-to, 0deg)); }
  }

  /* A demo that moves without being asked is worse than none for anyone who set this. */
  @media (prefers-reduced-motion: reduce) {
    .anim { animation: none; transform: var(--travel); }
    .limb { animation: none; transform: rotate(var(--swing)); }
    .joint { animation: none; transform: rotate(var(--bend-to, 0deg)); }
  }
`);

export class ExerciseDemo extends HTMLElement {
  #root: ShadowRoot;
  #exercise: Exercise | undefined;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [ios, styles];
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
