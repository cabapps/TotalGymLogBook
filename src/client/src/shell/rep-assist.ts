/**
 * <tg-rep-assist>
 *
 * The rep-counting assist strip inside <tg-set-logger>. Picks a source, holds the permission
 * gesture, and shows the running count.
 *
 * Three things from docs/adr/0006 are load-bearing here and easy to lose:
 *
 *   Capability detection never prompts. The buttons that appear are the ones the device could
 *   support; the prompt happens on tap, inside the gesture, because iOS throws otherwise.
 *
 *   Sources are additive, not exclusive. The +/- stepper stays live the whole time, so an
 *   automatic source is a convenience over a working manual control, never a mode you get
 *   trapped in with a wrong number.
 *
 *   Nothing auto-completes the set. The count is a suggestion until the trainee taps Log set.
 *   A silently wrong count corrupts the progression history everything else is derived from.
 */

import { RepCounter, type RepSource } from '../reps/counter.js';
import { MotionRepSource } from '../reps/motion.js';
import { VoiceRepSource } from '../reps/voice.js';
import * as db from '../db/repository.js';

export type AssistMode = 'off' | 'voice' | 'motion';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; margin-top: .6rem; }
  .bar { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
  .label { font-size: .7rem; color: var(--muted); margin-right: .1rem; }
  button {
    font: inherit; font-size: .7rem; padding: .28rem .6rem; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--muted); cursor: pointer;
  }
  button[aria-pressed="true"] {
    background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600;
  }
  button.stop { border-color: #b45309; color: #b45309; font-weight: 600; }
  .status { font-size: .7rem; color: var(--muted); margin: .4rem 0 0; line-height: 1.4; }
  .status.live { color: var(--accent); }
  .status.bad { color: #b45309; }
  .dot {
    display: inline-block; width: .45rem; height: .45rem; border-radius: 50%;
    background: var(--accent); margin-right: .3rem; vertical-align: baseline;
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .25 } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none } }
`);

export class RepAssist extends HTMLElement {
  #root: ShadowRoot;
  #sources = new Map<AssistMode, RepSource>([
    ['voice', new VoiceRepSource()],
    ['motion', new MotionRepSource()],
  ]);
  #availability = new Map<AssistMode, boolean>();
  #preferences: Record<string, string> = {};
  #exerciseId = '';
  #mode: AssistMode = 'off';
  #status = '';
  #statusKind: 'idle' | 'live' | 'bad' = 'idle';
  #counter = new RepCounter((count) => {
    this.dispatchEvent(
      new CustomEvent('reps-detected', { bubbles: true, composed: true, detail: { count } }),
    );
    this.#renderStatus();
  });

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
  }

  async connectedCallback(): Promise<void> {
    // Probing is pure detection -- no permission dialogs fire here (docs/adr/0006 rule 1).
    for (const [mode, source] of this.#sources) {
      this.#availability.set(mode, await source.isAvailable());
    }

    this.#preferences = (await db.getSettings()).repAssist ?? {};
    this.#render();
  }

  disconnectedCallback(): void {
    void this.#stop();
  }

  /** The mode currently running. */
  get mode(): AssistMode {
    return this.#mode;
  }

  /**
   * Follows the exercise selector. Switching exercises mid-workout switches to whatever source
   * that exercise was last counted with -- which is the point of storing the preference per
   * exercise rather than globally (docs/adr/0006): the phone belongs on the board for a chest
   * press and nowhere near it for a standing cable row.
   *
   * Only switches while assist is already running. Starting a source needs a user gesture, and
   * changing a dropdown is not consent to switch the microphone on.
   */
  async setExercise(exerciseId: string): Promise<void> {
    if (exerciseId === this.#exerciseId) return;
    this.#exerciseId = exerciseId;

    if (this.#mode === 'off') return;

    const preferred = this.#preferences[exerciseId] as AssistMode | undefined;
    if (preferred === this.#mode) return;

    await this.#stop();
    if (preferred && preferred !== 'off' && this.#availability.get(preferred)) {
      await this.#activate(preferred);
    }
    this.#render();
  }

  /** Keeps the counter anchored when the trainee edits reps by hand. */
  syncCount(count: number): void {
    this.#counter.setCount(count);
  }

  /** Called after a set is logged: the next set starts from zero. */
  reset(): void {
    this.#counter.reset();
    this.#renderStatus();
  }

  /**
   * The set is done.
   *
   * Voice stops listening; motion keeps going. The asymmetry is deliberate and is about what
   * the source costs while it is idle. A live microphone through a two-minute rest period is
   * listening to a conversation it has no business hearing, and the trainee has no way to tell
   * that it is on. An accelerometer costs nothing and re-arming it before every set is friction
   * with no upside.
   */
  async finishSet(): Promise<void> {
    if (this.#mode === 'voice') {
      await this.#stop();
      this.#say('Stopped listening. Tap to count the next set.', 'idle');
      this.#render();
      return;
    }

    this.reset();
  }

  /** Switches source without a user gesture. Only ever used to turn assist OFF. */
  async setMode(mode: AssistMode): Promise<void> {
    if (mode !== 'off') throw new Error('Turning assist on requires a user gesture.');
    await this.#stop();
  }

  async #stop(): Promise<void> {
    const current = this.#sources.get(this.#mode);
    if (current) await current.stop();
    this.#mode = 'off';
    this.#say('', 'idle');
  }

  /** Called from a click, so the permission gesture is intact (docs/adr/0006 rule 2). */
  async #choose(mode: AssistMode): Promise<void> {
    // Tapping the active source turns it off, which is the obvious meaning of a pressed toggle
    // and also the escape hatch if it is miscounting.
    const wanted = mode === this.#mode ? 'off' : mode;

    await this.#stop();
    if (wanted !== 'off') await this.#activate(wanted);

    this.#render();
    await this.#remember(wanted);
  }

  async #activate(mode: AssistMode): Promise<void> {
    const source = this.#sources.get(mode);
    if (!source) return;

    if (source.requestPermission) {
      const granted = await source.requestPermission();
      if (!granted) {
        this.#say(`${source.label} needs permission, which was declined.`, 'bad');
        return;
      }
    }

    this.#mode = mode;

    // Assist starts from zero, not from whatever the stepper shows. The stepper carries the
    // last set's count forward, which is right for logging by hand and completely wrong here:
    // starting at 10 means the first nine numbers the trainee says are below the running total
    // and get discarded as going backwards.
    this.#counter.reset();
    this.#say(mode === 'voice' ? 'Listening — count out loud.' : 'Watching for movement.', 'live');

    await source.start(
      (event) => this.#counter.accept(event),
      (message) => {
        this.#say(message, 'bad');
        void this.#stop().then(() => this.#render());
      },
    );

    this.dispatchEvent(
      new CustomEvent('assist-changed', { bubbles: true, composed: true, detail: { mode } }),
    );
  }

  async #remember(mode: AssistMode): Promise<void> {
    if (!this.#exerciseId) return;

    this.#preferences = { ...this.#preferences, [this.#exerciseId]: mode };
    try {
      await db.saveSettings({ repAssist: this.#preferences });
    } catch {
      // A preference that fails to save is a nuisance, not a reason to stop counting.
    }
  }

  #say(status: string, kind: 'idle' | 'live' | 'bad'): void {
    this.#status = status;
    this.#statusKind = kind;
    this.#renderStatus();
  }

  #render(): void {
    const offered = [...this.#sources].filter(([mode]) => this.#availability.get(mode));

    if (offered.length === 0) {
      // Desktop, or an insecure context. Say nothing rather than showing dead controls.
      this.#root.innerHTML = '';
      return;
    }

    // An explicit Stop, not just "tap the pressed button again". Toggling a lit-up button off
    // is discoverable to whoever built it and to nobody else, and the microphone is exactly the
    // thing a trainee wants an unambiguous way to switch off.
    const stop = this.#mode === 'off' ? '' : '<button class="stop" id="stop">Stop</button>';

    this.#root.innerHTML = `
      <div class="bar">
        <span class="label">Count for me:</span>
        ${offered
          .map(
            ([mode, source]) =>
              `<button id="mode-${mode}" aria-pressed="${this.#mode === mode}">${source.label}</button>`,
          )
          .join('')}
        ${stop}
      </div>
      <p class="status" id="status"></p>
    `;

    for (const [mode] of offered) {
      this.#root
        .getElementById(`mode-${mode}`)!
        .addEventListener('click', () => void this.#choose(mode));
    }

    this.#root.getElementById('stop')?.addEventListener('click', () => {
      void this.#choose(this.#mode);
    });

    this.#renderStatus();
  }

  #renderStatus(): void {
    const element = this.#root.getElementById('status');
    if (!element) return;

    element.className = `status ${this.#statusKind === 'idle' ? '' : this.#statusKind}`;

    if (this.#mode !== 'off' && this.#statusKind === 'live') {
      const count = this.#counter.count;
      element.innerHTML = `<span class="dot"></span>${this.#status} ${
        count > 0 ? `Counted <b>${count}</b>.` : ''
      }`;
      return;
    }

    element.textContent = this.#status;
  }
}

customElements.define('tg-rep-assist', RepAssist);
