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
type RepEvent = { at: number; confidence: number; sourceId: string };

interface RepSource {
  readonly id: string;
  readonly label: string;
  isAvailable(): Promise<boolean>;         // pure detection, never prompts
  requestPermission?(): Promise<boolean>;  // must be called from a user gesture
  start(sink: (e: RepEvent) => void): Promise<void>;
  stop(): Promise<void>;
}
```

| Source | Availability |
|---|---|
| **Manual tap** | Always. Non-negotiable baseline. |
| **Device motion** | iOS + Android, after permission |
| **STATS BLE** | Stub — `isAvailable()` returns `false` |

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

- **Dedupe across sources** — coalesce events within ~300 ms.
- **Plausibility filter** — a Total Gym rep takes 1–4 s. Anything under ~600 ms is noise. One
  check kills most accelerometer false positives.
- **Never auto-complete a set.** Silently wrong counts corrupt the progression data that
  [0004](0004-domain-model-and-resistance.md) depends on. Show the running count, keep correction
  one tap away, require explicit confirmation to close the set. Treat user corrections as a
  per-source accuracy signal worth surfacing.

### Per-exercise preference

Store the preferred assist source **per exercise**, not globally. Motion counting works for
squats and chest press where the user is on the board, and not at all for standing cable work. A
single global setting would feel broken half the time.

## Rep duration as a fatigue signal

Rep *timestamps* — available from the motion source and, at lower resolution, from manual tapping
— give per-rep duration. Lengthening duration within a set is a proximity-to-failure proxy, the
variable that matters most for hypertrophy.

**Caveat:** velocity-based training research is almost entirely barbell work, and a
bodyweight-leverage machine with a 2:1 pulley is a different mechanical system. Surface this as a
rough within-set trend — *"your last two reps slowed noticeably, you were probably close to
failure"* — never a calibrated RIR number.

## Rejected

**Tempo metronome (prescribing cadence).** Rep cadence isn't important enough to lifting outcomes
to justify the feature. The useful half of the idea was *measuring* duration rather than
prescribing it, which is retained above.

**Accelerometer counting as the headline feature.** The signal is clean — the glideboard is
near-perfect one-dimensional reciprocating motion — but the phone has to sit on the board, which
is exactly where the user can't see it. It needs audio feedback and after-the-fact review. Worth
building as an assist mode, not as the primary story.
