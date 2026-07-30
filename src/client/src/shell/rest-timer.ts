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

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; }
  .bar {
    display: flex; align-items: center; gap: .75rem;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: .75rem; padding: .6rem .85rem;
  }
  .time {
    font-size: 1.5rem; font-weight: 650; font-variant-numeric: tabular-nums;
    min-width: 4.2rem; letter-spacing: -.02em;
  }
  .time.done { color: var(--accent); }
  .label { color: var(--muted); font-size: .8125rem; flex: 1; }
  button {
    font: inherit; font-size: .8125rem; padding: .35rem .7rem; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg); cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  :host([hidden]) { display: none; }
`);

export class RestTimer extends HTMLElement {
  #root: ShadowRoot;
  #interval?: number;
  #wakeLock: WakeLockSentinel | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
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
