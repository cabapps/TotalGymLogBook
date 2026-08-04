/**
 * <tg-rest-timer>
 *
 * Stores an absolute DEADLINE and derives the remaining time on every tick (docs/adr/0005).
 * Never counts down a variable: browsers throttle background timers to roughly once a minute,
 * so a decrementing counter drifts badly, and a reload wipes it entirely. Deriving from
 * `endsAt - Date.now()` recovers exactly through a backgrounded tab, a locked screen, a
 * reload, and a Blazor restart, because there is no accumulated state to corrupt.
 *
 * The deadline lives in sessionStorage, which is the in-flight UI tier from docs/adr/0005 --
 * fast, synchronous, and correctly discarded when the tab closes.
 */

const KEY = 'tg.restEndsAt';

import { ios } from './theme.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; margin-bottom: var(--group-gap); }
  .bar {
    display: flex; align-items: center; gap: .6rem;
    background: var(--surface); border-radius: var(--radius-card);
    padding: .5rem .75rem .5rem var(--gutter);
  }
  /* A countdown is a number you glance at from three feet away mid-set. Rounded, tabular, big. */
  .time {
    font-family: var(--font-rounded);
    font-size: var(--text-title1); font-weight: 700; letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums; min-width: 4rem;
  }
  .time.done { color: var(--system-green); }
  .label { color: var(--muted); font-size: var(--text-subhead); flex: 1; }
  button {
    min-height: 2rem; padding: 0 .75rem;
    border: 0; border-radius: var(--radius-small);
    background: var(--fill); color: var(--accent);
    font-size: var(--text-subhead); font-weight: 500;
  }
`);

export class RestTimer extends HTMLElement {
  #root: ShadowRoot;
  #interval?: number;
  #wakeLock: WakeLockSentinel | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [ios, styles];
    this.#root.innerHTML = `
      <div class="bar">
        <div class="time" id="time">0:00</div>
        <div class="label" id="label">Rest</div>
        <button id="add">+30s</button>
        <button id="skip">Skip</button>
      </div>
    `;
  }

  connectedCallback(): void {
    this.#root.getElementById('add')!.addEventListener('click', () => this.extend(30));
    this.#root.getElementById('skip')!.addEventListener('click', () => this.stop());

    // Recompute whenever the tab comes back, since throttling means the interval may not have
    // fired while hidden.
    document.addEventListener('visibilitychange', this.#onVisible);

    this.#tick();
    this.#interval = window.setInterval(() => this.#tick(), 250);
  }

  disconnectedCallback(): void {
    document.removeEventListener('visibilitychange', this.#onVisible);
    if (this.#interval) clearInterval(this.#interval);
    void this.#releaseWakeLock();
  }

  #onVisible = (): void => {
    if (document.visibilityState === 'visible') {
      this.#tick();
      // A wake lock is dropped when the page is hidden and must be re-acquired by hand.
      if (this.remainingMs > 0) void this.#requestWakeLock();
    }
  };

  /** Absolute epoch-ms deadline, or 0 when idle. */
  get endsAt(): number {
    return Number(sessionStorage.getItem(KEY) ?? 0);
  }

  set endsAt(value: number) {
    if (value > 0) sessionStorage.setItem(KEY, String(value));
    else sessionStorage.removeItem(KEY);
    this.#tick();
  }

  get remainingMs(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  start(seconds: number): void {
    this.endsAt = Date.now() + seconds * 1000;
    void this.#requestWakeLock();
  }

  extend(seconds: number): void {
    // Extending an expired timer restarts from now, which is what a tap on "+30s" means.
    const base = Math.max(this.endsAt, Date.now());
    this.endsAt = base + seconds * 1000;
    void this.#requestWakeLock();
  }

  stop(): void {
    this.endsAt = 0;
    void this.#releaseWakeLock();
    this.dispatchEvent(new CustomEvent('rest-skipped', { bubbles: true, composed: true }));
  }

  #tick(): void {
    const ms = this.remainingMs;
    const idle = this.endsAt === 0;

    this.hidden = idle;
    if (idle) return;

    const total = Math.ceil(ms / 1000);
    const time = this.#root.getElementById('time')!;
    time.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;

    const done = ms === 0;
    time.classList.toggle('done', done);
    this.#root.getElementById('label')!.textContent = done ? 'Rest complete' : 'Rest';

    if (done && !this.#firedComplete) {
      this.#firedComplete = true;
      void this.#releaseWakeLock();
      this.dispatchEvent(new CustomEvent('rest-complete', { bubbles: true, composed: true }));
    } else if (!done) {
      this.#firedComplete = false;
    }
  }

  #firedComplete = false;

  /**
   * Keeps the screen awake between sets. Well supported (Chrome; Safari 16.4+), and absent
   * elsewhere -- so this is entirely best-effort and never blocks the timer.
   *
   * Note docs/adr/0005's honest limitation: this does NOT make a backgrounded PWA able to
   * notify reliably. There is no dependable way to schedule a local notification without a
   * push server, so the rest timer is something you glance at, not something that interrupts.
   */
  async #requestWakeLock(): Promise<void> {
    if (this.#wakeLock || !('wakeLock' in navigator)) return;
    try {
      this.#wakeLock = await navigator.wakeLock.request('screen');
      this.#wakeLock.addEventListener('release', () => (this.#wakeLock = null));
    } catch {
      // Denied, or the document is not visible. Not worth surfacing.
    }
  }

  async #releaseWakeLock(): Promise<void> {
    try {
      await this.#wakeLock?.release();
    } catch {
      /* already gone */
    }
    this.#wakeLock = null;
  }
}

customElements.define('tg-rest-timer', RestTimer);
