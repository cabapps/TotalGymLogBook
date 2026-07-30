/**
 * The instant tier (docs/adr/0003).
 *
 * This element paints and becomes interactive before the .NET runtime exists. It runs the
 * resistance calculation locally, which is exactly why that calculation is mirrored in
 * TypeScript rather than living only in Domain -- the readout must update as the level
 * selector moves, and waiting 1-3s for Blazor to boot would defeat the point.
 */

import { RailProfileTable } from '../profiles.js';
import { addedWeightEfficiency, computeResistance, type RailProfile } from '../resistance.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; padding: 1rem; max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  .sub { color: var(--muted); font-size: .8125rem; margin: 0 0 1.25rem; }
  .readout {
    background: var(--surface); border: 1px solid var(--border); border-radius: .75rem;
    padding: 1rem; margin-bottom: 1rem;
  }
  .lb { font-size: 2.75rem; font-weight: 650; line-height: 1; font-variant-numeric: tabular-nums; }
  .lb small { font-size: 1rem; font-weight: 400; color: var(--muted); margin-left: .25rem; }
  .hint { color: var(--muted); font-size: .8125rem; margin-top: .5rem; }
  label { display: block; font-size: .8125rem; color: var(--muted); margin: .75rem 0 .25rem; }
  input[type=range] { width: 100%; accent-color: var(--accent); }
  input[type=number] {
    width: 100%; padding: .5rem; font: inherit; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  }
  .row { display: flex; gap: .75rem; }
  .row > * { flex: 1; }
  .toggle { display: flex; align-items: center; gap: .5rem; margin-top: .75rem; font-size: .875rem; }
  .badge {
    display: inline-block; font-size: .6875rem; letter-spacing: .04em; text-transform: uppercase;
    background: var(--accent); color: #fff; border-radius: 999px; padding: .15rem .5rem;
  }
`);

export class AppShell extends HTMLElement {
  #profiles?: RailProfileTable;
  #profile?: RailProfile;
  #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
  }

  async connectedCallback(): Promise<void> {
    this.#root.innerHTML = `<p class="sub">Loading…</p>`;

    const res = await fetch('data/rail-profiles.json');
    this.#profiles = RailProfileTable.parse(await res.text());
    this.#profile = this.#profiles.forLevelCount(14); // FIT Anniversary

    this.#render();
  }

  #render(): void {
    const p = this.#profile!;
    this.#root.innerHTML = `
      <h1>Total Gym Logbook <span class="badge">instant tier</span></h1>
      <p class="sub">
        Rendered before Blazor booted. ${p.levelCount}-notch rail,
        ${p.boardWeightLb} lb glideboard.
      </p>

      <div class="readout">
        <div class="lb"><span id="lb">—</span><small>lb</small></div>
        <div class="hint" id="hint"></div>
      </div>

      <div class="row">
        <div>
          <label for="bw">Bodyweight (lb)</label>
          <input type="number" id="bw" value="180" min="50" max="400" step="1" />
        </div>
        <div>
          <label for="vest">Added weight (lb)</label>
          <input type="number" id="vest" value="0" min="0" max="100" step="2.5" />
        </div>
      </div>

      <label for="level">Level <span id="levelText">8</span></label>
      <input type="range" id="level" min="1" max="${p.levelCount}" value="8" step="1" />

      <label class="toggle">
        <input type="checkbox" id="pulley" /> Cable exercise (pulley halves the load)
      </label>
    `;

    for (const id of ['bw', 'vest', 'level', 'pulley']) {
      this.#root.getElementById(id)!.addEventListener('input', () => this.#update());
    }
    this.#update();
  }

  #update(): void {
    const p = this.#profile!;
    const $ = (id: string) => this.#root.getElementById(id) as HTMLInputElement;

    const level = Number($('level').value);
    const bodyweightLb = Number($('bw').value) || 0;
    const vestLb = Number($('vest').value) || 0;
    const usesPulley = $('pulley').checked;

    const lb = computeResistance(p, { bodyweightLb, level, vestLb, usesPulley });
    const perLb = addedWeightEfficiency(p, level, usesPulley);

    this.#root.getElementById('levelText')!.textContent = String(level);
    this.#root.getElementById('lb')!.textContent = lb.toFixed(1);

    // The counterintuitive bit from docs/adr/0004, surfaced rather than hidden.
    this.#root.getElementById('hint')!.textContent = vestLb > 0
      ? `Your ${vestLb} lb of added weight contributes ${(vestLb * perLb).toFixed(1)} lb here.`
      : `Every 10 lb you add here is worth ${(10 * perLb).toFixed(1)} lb of resistance.`;
  }
}

customElements.define('tg-app-shell', AppShell);
