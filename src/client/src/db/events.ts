/**
 * The single typed event bus from docs/adr/0003 rule 3.
 *
 * Two consumers, one channel:
 *   - Blazor subscribes once and re-reads through the bridge when something changes. It never
 *     receives object graphs across the interop boundary, only "store X changed" (rule 2).
 *   - Other tabs get the same notification via BroadcastChannel, which is what keeps a second
 *     tab in sync (docs/adr/0005).
 */

import type { StoreName } from './schema.js';

export const CHANNEL_NAME = 'tg-db';

export interface ChangeEvent {
  store: StoreName;
  /** Ids touched. Consumers re-read rather than trusting payloads. */
  ids: string[];
  /** True when the change came from another tab. */
  remote: boolean;
}

export type ChangeListener = (event: ChangeEvent) => void;

const listeners = new Set<ChangeListener>();

let channel: BroadcastChannel | undefined;
let channelTried = false;

function getChannel(): BroadcastChannel | undefined {
  if (channelTried) return channel;
  channelTried = true;

  // Absent in some webviews and in Node under test. Cross-tab sync degrades; nothing else does.
  if (typeof BroadcastChannel === 'undefined') return undefined;

  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (message) => {
    const detail = message.data as ChangeEvent;
    emitLocal({ ...detail, remote: true });
  };
  return channel;
}

function emitLocal(event: ChangeEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      // One bad subscriber must not stop the others, and must never fail a write.
      console.error('change listener threw', error);
    }
  }
}

/** Announces a local write to this tab and every other one. */
export function publishChange(store: StoreName, ids: string[]): void {
  const event: ChangeEvent = { store, ids, remote: false };
  emitLocal(event);
  getChannel()?.postMessage({ store, ids });
}

export function onChange(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test hook. */
export function resetEvents(): void {
  listeners.clear();
  channel?.close();
  channel = undefined;
  channelTried = false;
}
