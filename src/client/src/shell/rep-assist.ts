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

/**
 * Minimal shapes for the Screen Wake Lock API.
 *
 * Declared here rather than pulled from lib.dom: the app targets iOS Safari, where this arrived
 * late, and the TypeScript DOM library in use does not carry it.
 */
interface WakeLockSentinelLike {
  release(): Promise<void>;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export type AssistMode = 'off' | 'voice' | 'motion';

import { ios } from './theme.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; margin-top: .7rem; }
  .bar { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
  .label { font-size: var(--text-footnote); color: var(--muted); margin-right: .15rem; }
  button {
    min-height: 2rem; padding: 0 .8rem;
    border: 0; border-radius: var(--radius-small);
    background: var(--fill); color: var(--accent);
    font-size: var(--text-subhead); font-weight: 500;
  }
  button[aria-pressed="true"] { background: var(--accent); color: #fff; }
  /* Stop is not destructive -- nothing is lost -- but it is the one control that must be found
     without reading, so it gets the warning color rather than the tint. */
  button.stop { color: var(--warn); }
  .status { font-size: var(--text-footnote); color: var(--muted); margin: .45rem 0 0;
            line-height: 1.4; }
  .status.live { color: var(--accent); }
  .status.bad { color: var(--warn); }
  .dot {
    display: inline-block; width: .45rem; height: .45rem; border-radius: 50%;
    background: var(--accent); margin-right: .3rem; vertical-align: baseline;
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .25 } }
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
  #wakeLock: WakeLockSentinelLike | undefined;
  #visibilityHandler: (() => void) | undefined;
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
    this.#root.adoptedStyleSheets = [ios, styles];
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
   * The set is done. Both sources stop.
   *
   * Motion used to keep running through the rest period, on the theory that an accelerometer
   * costs nothing while idle. It does not: a phone that keeps counting while you walk to the
   * kitchen adds reps to the next set before it starts, and the trainee cannot see it happening
   * because they are not looking at the phone. Whatever the battery argument, a counter that
   * counts walking is worse than one that needs a tap.
   */
  async finishSet(): Promise<void> {
    if (this.#mode === 'off') {
      this.reset();
      return;
    }

    const wasVoice = this.#mode === 'voice';
    await this.#stop();
    this.#say(
      wasVoice
        ? 'Stopped listening. Tap to count the next set.'
        : 'Stopped counting. Tap to count the next set.',
      'idle',
    );
    this.#render();
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
    await this.#releaseScreen();
  }

  /**
   * Keeps the screen on while a source is counting, and reacquires it when the app comes back to
   * the foreground -- the lock is dropped automatically whenever the page is hidden, so without
   * the listener it survives exactly one glance at a notification.
   */
  async #holdScreenAwake(): Promise<void> {
    const locks = (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock;
    if (!locks) return;

    try {
      this.#wakeLock = await locks.request('screen');
    } catch {
      // Refused, or the battery is too low. Not worth telling the trainee about: the counter
      // still works, it just stops when the screen does.
      this.#wakeLock = undefined;
    }

    this.#visibilityHandler ??= () => {
      if (document.visibilityState === 'visible' && this.#mode !== 'off') {
        void this.#holdScreenAwake();
      }
    };
    document.addEventListener('visibilitychange', this.#visibilityHandler);
  }

  async #releaseScreen(): Promise<void> {
    if (this.#visibilityHandler) {
      document.removeEventListener('visibilitychange', this.#visibilityHandler);
      this.#visibilityHandler = undefined;
    }

    try {
      await this.#wakeLock?.release();
    } catch {
      // Already released, or the page was hidden. Nothing to do either way.
    }
    this.#wakeLock = undefined;
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

    // The field goes back to zero with the counter. Leaving the last set's number in it while a
    // source counts up from zero means the two disagree from the first rep, and the trainee has
    // no way to know which one the Log button will believe.
    this.dispatchEvent(
      new CustomEvent('assist-started', { bubbles: true, composed: true, detail: { mode } }),
    );

    // The screen must stay awake while a source is running. Voice recognition stops with the
    // screen, and the trainee is mid-set with the phone face down -- they find out it stopped
    // when they pick it up and the count is wrong. Best effort: unsupported or refused, the
    // counter still works for as long as the screen happens to stay on.
    // Deliberately not awaited: the counter is armed and the UI should say so now. Waiting on a
    // permission-shaped API before showing the toggle as pressed makes the button feel broken on
    // exactly the platforms where the lock is least likely to be granted.
    void this.#holdScreenAwake();

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
