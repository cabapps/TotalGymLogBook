# 0006 — Rep sources and capability negotiation

**Status:** Accepted

## Context

Reps can potentially be counted several ways: manually, from the phone's accelerometer, or from
a Total Gym STATS device. These differ in availability, permission requirements, and
trustworthiness, and the set logger must work regardless.

### Why STATS BLE is not a shipping feature

Two independent blockers:

1. **The protocol is proprietary and undocumented.** STATS is an optical sensor on the glideboard
   that counts reps by watching reflective tape. Total Gym publishes no SDK, and no public
   reverse-engineering work exists. It also won't be speaking a standard profile — the Bluetooth
   SIG Fitness Machine Profile (`0x1826`) covers treadmills, bikes, rowers, and cross-trainers,
   with no machine type for an incline glideboard. Expect a vendor-defined service UUID.
2. **Web Bluetooth does not exist on iOS.** Chromium ships it; Safari and Firefox have both
   explicitly declined to implement it, and on iOS/iPadOS every browser is WebKit underneath, so
   there is no "just use Chrome" escape hatch. Global support is ~76%, but the Total Gym audience
   skews heavily toward an iPad propped in front of the machine. Workarounds exist (Bluefy,
   the iOSWebBLE extension) but "install a third-party browser first" is a non-starter.

Heart-rate straps have the same browser problem, though they at least speak the standard Heart
Rate Service (`0x180D`) and need no reverse engineering.

## Decision

**A `RepSource` interface in TypeScript. Blazor never sees it.**

By the complexity heuristic, accelerometer signal processing looks like a .NET job. But it's a
60 Hz stream needing low latency and pre-boot availability — marshalling 60 samples/sec across
the interop boundary to save 80 lines of filter code is the wrong trade. Load-time principle
outranks complexity principle, same as the resistance calculator.

```ts
type RepEvent =
  | { kind: 'increment'; at: number; confidence: number; sourceId: string }
  | { kind: 'count'; at: number; count: number; confidence: number; sourceId: string };

interface RepSource {
  readonly id: string;
  readonly label: string;
  isAvailable(): Promise<boolean>;         // pure detection, never prompts
  requestPermission?(): Promise<boolean>;  // must be called from a user gesture
  start(sink: (e: RepEvent) => void, onError?: (message: string) => void): Promise<void>;
  stop(): Promise<void>;
}
```

| Source | Availability |
|---|---|
| **Manual tap** | Always. Non-negotiable baseline. |
| **Device motion** | iOS + Android, after permission |
| **Voice** | Anywhere `SpeechRecognition` exists, including iOS Safari |
| **STATS BLE** | Stub — `isAvailable()` returns `false` |

### Two kinds of event, and why one type will not do

`RepEvent` was originally a bare "a rep happened" signal, which is right for motion and wrong
for voice, and the difference is not cosmetic.

Someone counting out loud is reporting a **total**, not signalling an event. Recognition drops
words constantly under exertion — that is the normal case, not the failure case — so
incrementing once per number heard undercounts every set. Taking the highest number heard is
self-healing instead: miss "three" and "four" entirely and the trainee saying "five" still
lands on five.

So sources emit whichever they can honestly observe, and `RepCounter` owns the running total.

### Guarding an absolute count

The dangerous misrecognition is not a missed number, it is a **wrong high** one — "four"
through gritted teeth comes back as "forty". So an absolute count is accepted only when it is
greater than the running total and no more than **three** ahead of it. That single bound:

- accepts the ordinary case of dropped words (a gap of one or two is routine),
- rejects the order-of-magnitude misread,
- and makes a cold start refuse to jump to twelve, because counting starts at one.

It also falls out that a spurious *low* number is free — it is simply not greater than the
total, so it is discarded without needing a rule of its own.

`RepCounter` owns the total rather than each source, which is what makes rule 3 real: tap the
stepper to 5, say "six", get six. A source holding its own count would argue with the trainee.

STATS ships as **the interface with no implementation**, behind a flag. If someone reverse-engineers
the protocol it drops straight in.

### Three rules

1. **`isAvailable()` must never prompt.** Capability detection and permission requests are
   different operations. Conflate them and opening the app fires a Bluetooth device chooser at
   someone who just wanted to log a set.
2. **Permission requests must originate from a user gesture.** Both
   `DeviceMotionEvent.requestPermission()` on iOS and `navigator.bluetooth.requestDevice()` throw
   if called outside a click handler. Capability negotiation and permission acquisition are
   therefore separate UI phases, and neither can happen during app init.
3. **Sources are additive, not exclusive.** Manual tap stays live *while* an automatic source
   runs, so the tap is a correction mechanism rather than an alternative mode. There is never a
   state where the user cannot fix a miscount.

### Guards

- **Dedupe across sources** — coalesce events within ~300 ms. **Implemented as a single 600 ms
  refractory period**, which subsumes it: two sources reporting the same rep are necessarily
  inside 600 ms of each other, so one rule does both jobs and there is no second window to keep
  in sync.
- **Plausibility filter** — a Total Gym rep takes 1–4 s. Anything under ~600 ms is noise. One
  check kills most accelerometer false positives. Note what it does *not* do: it rate-limits,
  it does not classify. Walking with the phone in a pocket still produces events, just capped
  at one per 600 ms. Distinguishing gait from reps is not attempted, because the trainee knows
  which they are doing and the stepper is right there.
- **Never auto-complete a set.** Silently wrong counts corrupt the progression data that
  [0004](0004-domain-model-and-resistance.md) depends on. Show the running count, keep correction
  one tap away, require explicit confirmation to close the set. Treat user corrections as a
  per-source accuracy signal worth surfacing.

### Per-exercise preference

Store the preferred assist source **per exercise**, not globally. Motion counting works for
squats and chest press where the user is on the board, and not at all for standing cable work. A
single global setting would feel broken half the time.

## Detector notes, learned by building it

**Project onto measured gravity, do not use magnitude.** `|acceleration|` peaks on both the
push and the return, so a magnitude-based detector reports double. Taking the dynamic
acceleration projected onto the slow EMA of the gravity vector gives a *signed* one-dimensional
signal, and counting one full cycle — trigger, fall back through a re-arm level, trigger again
— makes one rep one rep.

That projection also makes the detector indifferent to which pocket the phone is in, because
the rail is inclined and every Total Gym movement therefore has a large vertical component.

**Express thresholds as a fraction of measured gravity, never in m/s².** Implementations
disagree on both scale and sign — Safari's `accelerationIncludingGravity` is negated relative
to Chrome's. Dividing by the device's own resting magnitude removes the units question, and
counting cycles rather than directed peaks removes the sign question. Both are pinned by tests.

**Adapt the threshold to the recent peak, not to the mean.** The first version set the
threshold at 1.7 × the mean absolute signal, which sounds conservative and is in fact
impossible: for a sinusoid, peak is only π/2 ≈ 1.57 × mean absolute, so the threshold sat
permanently above the signal. It counted exactly one rep per set and then went quiet, because
the "noise floor" it was measuring was mostly the reps. Tracking a slowly decaying peak and
triggering at 45% of it scales *with* the movement instead of against it.

The detector is a pure synchronous class, so all of this is tested against synthetic waveforms
— a sinusoid at realistic cadence, the same trace sign-flipped and axis-rotated, pure noise,
and motion too fast to be a rep — with no phone involved.

## Rep duration as a fatigue signal

Rep *timestamps* — available from the motion source and, at lower resolution, from manual tapping
— give per-rep duration. Lengthening duration within a set is a proximity-to-failure proxy, the
variable that matters most for hypertrophy.

**Caveat:** velocity-based training research is almost entirely barbell work, and a
bodyweight-leverage machine with a 2:1 pulley is a different mechanical system. Surface this as a
rough within-set trend — *"your last two reps slowed noticeably, you were probably close to
failure"* — never a calibrated RIR number.

## Voice, specifically

The case motion cannot serve: standing cable work, and anyone unwilling to put a phone on the
glideboard where they cannot see it. The trainee counts out loud and the number follows.

- **`webkitSpeechRecognition` is the target**, not the unprefixed modern API. iOS Safari has
  shipped the prefixed one for years, and the audience is holding an iPhone.
- **On-device recognition is opportunistic.** Where `SpeechRecognition.available()` reports the
  local model is installed (Chrome 139+), `processLocally` is set, which keeps audio off the
  network and works offline. Setting it *without* that check makes `start()` throw, so it is
  gated on the probe rather than on feature detection.
- **Interim results are used.** Waiting for a phrase to finalise puts the count a second behind
  the trainee. Revisions are safe because the total only moves forwards.
- **Recognition stops on its own after a pause**, and a trainee resting between reps produces
  exactly that, so `onend` restarts it. Consecutive hard failures back off and give up rather
  than spinning.
- **No spoken "log it".** Closing a set stays a deliberate tap, per the never-auto-complete
  rule below. A false trigger there writes a wrong set into the history everything else is
  derived from.

**Not claimed:** that this works well in a noisy gym, or through heavy breathing. It is
untested outside a browser on a desk. The guards are built so that when it fails it fails
quiet — a rejected count changes nothing — and the stepper is always one tap away.

## Rejected

**Tempo metronome (prescribing cadence).** Rep cadence isn't important enough to lifting outcomes
to justify the feature. The useful half of the idea was *measuring* duration rather than
prescribing it, which is retained above.

**Accelerometer counting as the headline feature.** The signal is clean — the glideboard is
near-perfect one-dimensional reciprocating motion — but the phone has to sit on the board, which
is exactly where the user can't see it. It needs audio feedback and after-the-fact review. Worth
building as an assist mode, not as the primary story.
