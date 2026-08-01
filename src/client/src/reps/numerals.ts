/**
 * Spoken numerals out of a speech-recognition transcript.
 *
 * Recognition returns whatever it thinks it heard, which for someone counting through a hard
 * set is a mixture of digits ("1 2 3"), words ("one two three"), and near-misses ("won too
 * free"). All three have to become numbers.
 *
 * The homophone table is deliberately loose. It can only produce a WRONG number, never a
 * missing one, and RepCounter's monotonic jump guard already bounds what a wrong number can do
 * -- so the cost of an over-eager mapping is nearly zero while the cost of a missing one is a
 * dropped rep. "for" and "to" are ordinary English words, but this parser only ever sees audio
 * captured while rep counting is switched on, where they are almost certainly "four" and "two".
 */

const UNITS: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** What counting under load actually comes back as. Only well-attested substitutions. */
const HOMOPHONES: Readonly<Record<string, number>> = {
  won: 1,
  to: 2, too: 2,
  tree: 3, free: 3,
  for: 4, fore: 4,
  sicks: 6,
  ate: 8,
  tan: 10,
};

function wordValue(token: string): number | undefined {
  return UNITS[token] ?? HOMOPHONES[token];
}

/**
 * Every number in the transcript, in the order spoken. Compounds ("twenty one", "twenty-one")
 * collapse to a single value.
 */
export function parseSpokenNumbers(transcript: string): number[] {
  const tokens = transcript
    .toLowerCase()
    .replace(/[-–—]/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);

  const found: number[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (/^\d{1,3}$/.test(token)) {
      found.push(Number(token));
      continue;
    }

    const tens = TENS[token];
    if (tens !== undefined) {
      // "twenty one" is one number; "twenty" followed by anything else is just twenty.
      const next = tokens[i + 1];
      const unit = next === undefined ? undefined : wordValue(next);

      if (unit !== undefined && unit >= 1 && unit <= 9) {
        found.push(tens + unit);
        i++;
      } else {
        found.push(tens);
      }
      continue;
    }

    const value = wordValue(token);
    if (value !== undefined) found.push(value);
  }

  return found;
}

/**
 * The highest number in the transcript, or undefined.
 *
 * Highest rather than last, because recognition revises interim results and can hand back a
 * shorter guess after a longer one. Rep counts only go up within a set; RepCounter enforces
 * that against the running total, and this enforces it within a single utterance.
 */
export function highestSpokenNumber(transcript: string): number | undefined {
  const numbers = parseSpokenNumbers(transcript);
  return numbers.length > 0 ? Math.max(...numbers) : undefined;
}
