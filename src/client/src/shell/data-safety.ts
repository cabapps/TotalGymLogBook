/**
 * <tg-data-safety>
 *
 * Export, import, and the two things that stop a browser deleting the logbook.
 *
 * docs/adr/0001 makes this load-bearing rather than decorative: there is no server, so an
 * evicted IndexedDB is unrecoverable. The ADR's mitigations are installing to the home screen,
 * requesting persistent storage, and exporting -- and this is where a user reaches all three.
 */

import { exportBackupJson, importBackup } from '../db/backup.js';
import {
  backupFilename,
  describeRisk,
  downloadFile,
  formatBytes,
  getStatus,
  promptInstall,
  requestPersistence,
  type StorageStatus,
} from '../storage.js';

const styles = new CSSStyleSheet();
styles.replaceSync(`
  :host { display: block; margin-top: 1.25rem; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: .75rem; padding: .9rem 1rem;
  }
  .card.warn { border-color: #d97706; }
  h3 { font-size: .8125rem; margin: 0 0 .4rem; font-weight: 600; }
  p { margin: 0 0 .6rem; font-size: .8125rem; color: var(--muted); line-height: 1.45; }
  p.warn { color: #b45309; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; }
  button {
    font: inherit; font-size: .8125rem; padding: .45rem .8rem; border-radius: .5rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg); cursor: pointer;
  }
  button.primary { background: var(--accent); color: #fff; border-color: var(--accent); font-weight: 600; }
  button:hover { border-color: var(--accent); }
  .meta { font-size: .7rem; color: var(--muted); margin-top: .6rem; }
  input[type=file] { display: none; }
  .result { font-size: .75rem; margin-top: .5rem; }
  .result.ok { color: var(--accent); }
  .result.bad { color: #b45309; }
`);

export class DataSafety extends HTMLElement {
  #root: ShadowRoot;
  #status?: StorageStatus;
  #message = '';
  #messageOk = true;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [styles];
  }

  connectedCallback(): void {
    window.addEventListener('tg-installable', this.#onCapabilityChange);
    window.addEventListener('tg-installed', this.#onCapabilityChange);
    void this.refresh();
  }

  disconnectedCallback(): void {
    window.removeEventListener('tg-installable', this.#onCapabilityChange);
    window.removeEventListener('tg-installed', this.#onCapabilityChange);
  }

  #onCapabilityChange = (): void => {
    void this.refresh();
  };

  async refresh(): Promise<void> {
    this.#status = await getStatus();
    this.#render();
  }

  #render(): void {
    const status = this.#status!;
    const risk = describeRisk(status);

    this.#root.innerHTML = `
      <div class="card${risk.level === 'warn' ? ' warn' : ''}">
        <h3>Your data</h3>
        <p class="${risk.level === 'warn' ? 'warn' : ''}" id="risk">${risk.text}</p>

        <div class="row">
          ${status.installable ? '<button class="primary" id="install">Add to home screen</button>' : ''}
          ${
            !status.persisted && status.canRequestPersistence && !status.installed
              ? '<button id="protect">Protect my data</button>'
              : ''
          }
          <button id="export">Export backup</button>
          <button id="import">Restore</button>
        </div>

        <input type="file" id="file" accept="application/json,.json" />

        ${this.#message ? `<p class="result ${this.#messageOk ? 'ok' : 'bad'}" id="result">${this.#message}</p>` : ''}

        <p class="meta" id="meta">
          ${
            status.usageBytes !== undefined
              ? `Using ${formatBytes(status.usageBytes)}${
                  status.quotaBytes ? ` of ${formatBytes(status.quotaBytes)} available` : ''
                }.`
              : ''
          }
          Everything stays on this device &mdash; nothing is uploaded.
        </p>
      </div>
    `;

    this.#root.getElementById('install')?.addEventListener('click', async () => {
      const outcome = await promptInstall();
      if (outcome === 'accepted') this.#say('Installed. Your logbook is protected now.', true);
      await this.refresh();
    });

    this.#root.getElementById('protect')?.addEventListener('click', async () => {
      const granted = await requestPersistence();
      this.#say(
        granted
          ? 'Done — your browser will keep this data.'
          : 'Your browser declined. Installing to your home screen is the reliable fix.',
        granted,
      );
      await this.refresh();
    });

    this.#root.getElementById('export')?.addEventListener('click', async () => {
      const json = await exportBackupJson();
      downloadFile(backupFilename(), json);
      this.#say(`Saved ${backupFilename()}.`, true);
      this.#render();
    });

    const file = this.#root.getElementById('file') as HTMLInputElement;
    this.#root.getElementById('import')?.addEventListener('click', () => file.click());

    file.addEventListener('change', async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;

      try {
        // Merge, not replace: last-write-wins on updatedAt means restoring an OLD backup
        // cannot clobber newer data, which is the common case when someone is recovering one
        // deleted session (docs/adr/0001).
        const result = await importBackup(await chosen.text(), 'merge');
        this.#say(
          `Restored — ${result.inserted} added, ${result.updated} updated, ${result.skipped} already current.`,
          true,
        );
      } catch (error) {
        this.#say((error as Error).message, false);
      }

      file.value = '';
      await this.refresh();
    });
  }

  #say(message: string, ok: boolean): void {
    this.#message = message;
    this.#messageOk = ok;
  }
}

customElements.define('tg-data-safety', DataSafety);
