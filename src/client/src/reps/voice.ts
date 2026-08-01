/**
 * Counting reps by saying the numbers out loud.
 *
 * The case this exists for is the one where motion counting cannot work: standing cable work,
 * or anyone who does not want a phone riding the glideboard where they cannot see it
 * (docs/adr/0006 rejects motion as the headline feature for exactly that reason).
 *
 * On-device recognition is used where the browser offers it, and the network service otherwise.
 * iOS Safari has shipped webkitSpeechRecognition for years, which matters more than the newer
 * API here -- the audience is holding an iPhone.
 */

import { highestSpokenNumber } from './numerals.js';
import type { RepEvent, RepSource } from './counter.js';

/** Minimal surface of the Web Speech API, which TypeScript's DOM lib still does not describe. */
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionResultLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionResultLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string; confidence: number }>>;
}

type SpeechRecognitionCtor = {
  new (): SpeechRecognitionLike;
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
};

function recognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/**
 * Recognition stops on its own after a pause, and a trainee resting between reps produces
 * exactly that. Restarting on every end is required, but a restart loop against a hard failure
 * would spin forever, so consecutive failures back off and then give up.
 */
const MAX_CONSECUTIVE_FAILURES = 4;

export class VoiceRepSource implements RepSource {
  readonly id = 'voice';
  readonly label = 'Count out loud';

  #recognition: SpeechRecognitionLike | undefined;
  #sink: ((event: RepEvent) => void) | undefined;
  #onError: ((message: string) => void) | undefined;
  #active = false;
  #failures = 0;

  isAvailable(): Promise<boolean> {
    return Promise.resolve(recognitionCtor() !== undefined && window.isSecureContext);
  }

  // No requestPermission: the microphone prompt is raised by start(), which is already required
  // to run inside a user gesture. Asking separately would prompt twice for one capability.

  async start(sink: (event: RepEvent) => void, onError?: (message: string) => void): Promise<void> {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      onError?.('This browser cannot listen for counts.');
      return;
    }

    this.#sink = sink;
    this.#onError = onError;
    this.#active = true;
    this.#failures = 0;

    const recognition = new Ctor();
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = true;
    // Interim results are what make this feel immediate -- waiting for a phrase to finalise puts
    // the count a second or more behind the trainee. Revisions are safe: the counter only ever
    // moves forwards.
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    // Opportunistic on-device recognition (Chrome 139+). Keeps audio off the network and works
    // offline, but ONLY once the model is installed -- setting it otherwise makes start()
    // throw, so it is gated on the availability probe rather than on feature detection.
    if (typeof Ctor.available === 'function') {
      try {
        const status = await Ctor.available({ langs: [recognition.lang], processLocally: true });
        if (status === 'available') recognition.processLocally = true;
      } catch {
        // Probing failed; the network service is a perfectly good fallback.
      }
    }

    recognition.onresult = (event) => this.#onResult(event);

    recognition.onerror = (event) => {
      // 'no-speech' and 'aborted' are ordinary punctuation in a set full of pauses.
      if (event.error === 'no-speech' || event.error === 'aborted') return;

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.#active = false;
        this.#onError?.('Microphone access was declined, so counting out loud is off.');
        return;
      }
      this.#failures++;
    };

    recognition.onend = () => {
      if (!this.#active) return;

      if (this.#failures >= MAX_CONSECUTIVE_FAILURES) {
        this.#active = false;
        this.#onError?.('Could not keep listening. Tap the reps to set them by hand.');
        return;
      }

      try {
        recognition.start();
      } catch {
        // Already starting. Harmless -- the next onend will try again.
      }
    };

    this.#recognition = recognition;

    try {
      recognition.start();
    } catch {
      this.#active = false;
      onError?.('Could not start listening.');
    }
  }

  stop(): Promise<void> {
    this.#active = false;
    this.#sink = undefined;

    // abort() rather than stop(): stop() delivers a final result, which would push one more
    // count in after the trainee has already switched the feature off.
    try {
      this.#recognition?.abort();
    } catch {
      // Never started, or already dead.
    }

    this.#recognition = undefined;
    return Promise.resolve();
  }

  #onResult(event: SpeechRecognitionResultLike): void {
    this.#failures = 0;

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const alternative = event.results[i]?.[0];
      if (!alternative) continue;

      const spoken = highestSpokenNumber(alternative.transcript);
      if (spoken === undefined) continue;

      this.#sink?.({
        kind: 'count',
        sourceId: this.id,
        at: Date.now(),
        count: spoken,
        // Recognition confidence is 0 on interim results in most engines, so floor it. The
        // counter's jump guard is the real filter; this figure is for display only.
        confidence: alternative.confidence || 0.5,
      });
    }
  }
}
