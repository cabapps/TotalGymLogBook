/**
 * Drawing a movement, for when the words are not enough.
 *
 * DRAWN, NOT FILMED. Every frame is generated from the exercise's own data -- position, facing,
 * grip and the joint that does the work -- so there is no artwork to license, no video to host,
 * and nothing to keep in step with the catalog by hand. Total Gym's photography and illustration
 * are theirs (docs/adr/0004); a stick figure on a rail is ours, and it stays correct because it
 * is generated from the same fields the setup instructions and the session ordering read.
 *
 * It is also the only kind of demo that fits the budget. A hundred short clips is tens of
 * megabytes and an offline story that does not work; this is a few hundred bytes of SVG built at
 * render time, and it works on a plane.
 *
 * HONEST ABOUT WHAT IT IS. A stick figure shows which way to face, what moves, and roughly how
 * far. It does not show form. The caption says so, because a trainee who takes a schematic for a
 * coach can hurt themselves being faithful to it.
 *
 * Pure, so it can be tested without a browser. <tg-exercise-demo> is the thin element around it.
 */

import type { Exercise } from './exercises.js';

/** Rail geometry, in the SVG's own units. The tower is up and to the left. */
const RAIL = { topX: 26, topY: 24, bottomX: 168, bottomY: 96 };

interface Pose {
  /** How far the board travels, as a fraction of the rail. */
  readonly travel: number;
  /** What the working limb does, drawn as a second animated group. */
  readonly limb: 'arms' | 'forearms' | 'legs' | 'torso' | 'none';
  readonly caption: string;
}

/**
 * What each movement pattern does on the rail.
 *
 * `travel` is the honest part: a squat moves the board a long way, a calf raise barely moves it,
 * and a trainee who has never seen the machine cannot tell that from a sentence.
 */
function poseFor(pattern: string): Pose {
  switch (pattern) {
    case 'press':
      return { travel: 0.34, limb: 'arms', caption: 'The board travels about a third of the rail. Arms do the work; the body stays put.'};
    case 'fly':
      return { travel: 0.26, limb: 'arms', caption: 'A wide arc, and the board moves less than a press. The stretch at the open end is the point.'};
    case 'pulldown':
      return { travel: 0.34, limb: 'arms', caption: 'Arms start overhead and finish past your shoulders. Long travel up the rail.'};
    case 'row':
      return { travel: 0.30, limb: 'arms', caption: 'Arms pull in to the waist. The board comes most of the way up the rail.'};
    case 'curl':
      return { travel: 0.18, limb: 'forearms', caption: 'Elbows stay put — only the forearms move, so the board travels a short way.'};
    case 'extend':
      return { travel: 0.18, limb: 'forearms', caption: 'Elbows stay put and still. Short travel, all of it from straightening the arm.'};
    case 'raise':
      return { travel: 0.16, limb: 'arms', caption: 'A short, controlled arc. The board barely moves, which is normal for this one.'};
    case 'squat':
      return { travel: 0.42, limb: 'legs', caption: 'The longest travel on the machine: the board runs most of the rail on every rep.'};
    case 'hinge':
      return { travel: 0.28, limb: 'legs', caption: 'Hips drive the board up the rail. The upper body stays where it is.'};
    case 'calf':
      return { travel: 0.10, limb: 'legs', caption: 'Almost no travel — ankles only. If the board is moving a long way, the knees are helping.'};
    case 'crunch':
      return { travel: 0.20, limb: 'torso', caption: 'A short curl of the torso. The board hardly moves, and that is right.'};
    default:
      return {
        travel: 0.06,
        limb: 'none',
        caption: 'Nothing travels. Hold the position, and count time rather than reps.',
      };
  }
}

/** Where along the rail the board sits at rest, and where it travels to. */
function railPoint(fraction: number): { x: number; y: number } {
  return {
    x: RAIL.bottomX + (RAIL.topX - RAIL.bottomX) * fraction,
    y: RAIL.bottomY + (RAIL.topY - RAIL.bottomY) * fraction,
  };
}

/**
 * The figure, drawn lying, sitting, kneeling or face down.
 *
 * Head first, because which end the head is at is the single thing a trainee most needs to get
 * right before they start -- and it is the thing the app was wrong about for a fortnight.
 */
function figureFor(exercise: Exercise, limb: Pose['limb']): string {
  const { position, facing } = exercise.setup;
  const towardTower = facing === 'tower';

  // The board's local frame: x runs up the rail toward the tower.
  const head = towardTower ? -16 : 16;
  const foot = -head;

  const torso = `<line class="figure" x1="${head * 0.55}" y1="-8" x2="${foot * 0.5}" y2="-8" />`;
  const headDot = `<circle class="head" cx="${head}" cy="-10" r="4" />`;

  if (position === 'seated' || position === 'kneeling') {
    // Upright: the torso stands off the board and the legs fold along it.
    return `
      <g>
        <circle class="head" cx="${head * 0.5}" cy="-26" r="4" />
        <line class="figure" x1="${head * 0.5}" y1="-22" x2="${head * 0.2}" y2="-8" />
        <line class="figure" x1="${head * 0.2}" y1="-8" x2="${foot * 0.7}" y2="-6" />
        <g class="${limb === 'legs' ? 'anim' : ''}">
          <line class="figure" x1="${foot * 0.7}" y1="-6" x2="${foot}" y2="-2" />
        </g>
        <g class="${limb === 'arms' || limb === 'forearms' ? 'anim' : ''}">
          <line class="figure" x1="${head * 0.45}" y1="-20" x2="${head * 1.1}" y2="-16" />
        </g>
      </g>`;
  }

  if (position === 'face-down') {
    return `
      <g>
        ${headDot}
        ${torso}
        <g class="${limb === 'arms' || limb === 'forearms' ? 'anim' : ''}">
          <line class="figure" x1="${head * 0.55}" y1="-8" x2="${head * 1.15}" y2="-2" />
        </g>
        <g class="${limb === 'legs' ? 'anim' : ''}">
          <line class="figure" x1="${foot * 0.5}" y1="-8" x2="${foot}" y2="-4" />
        </g>
      </g>`;
  }

  // Face up, and side-lying, which reads the same from this angle.
  return `
    <g>
      ${headDot}
      ${torso}
      <g class="${limb === 'arms' || limb === 'forearms' ? 'anim' : ''}">
        <line class="figure" x1="${head * 0.5}" y1="-8" x2="${head * 1.05}" y2="-20" />
      </g>
      <g class="${limb === 'legs' ? 'anim' : ''}">
        <line class="figure" x1="${foot * 0.5}" y1="-8" x2="${foot * 1.1}" y2="-16" />
      </g>
      <g class="${limb === 'torso' ? 'anim' : ''}">
        <line class="figure" x1="${head * 0.55}" y1="-8" x2="${head * 0.8}" y2="-18" />
      </g>
    </g>`;
}

/** The SVG for one exercise. Exported so it can be tested without a browser. */
export function demoSvg(exercise: Exercise): string {
  const pose = poseFor(exercise.pattern);
  const rest = railPoint(0.12);
  const moved = railPoint(0.12 + pose.travel);

  // Anchored at MID-travel rather than at the resting position. The cable cannot follow the board
  // -- a CSS transform cannot rewrite path data -- so a cable drawn where the board starts hangs
  // visibly loose for half of every cycle. Splitting the difference is wrong by half as much in
  // both directions, which is the best a schematic can do here.
  const mid = railPoint(0.12 + pose.travel / 2);
  const cable = exercise.usesPulley
    ? `<path class="cable" d="M ${RAIL.topX + 4} ${RAIL.topY - 12} Q ${mid.x} ${mid.y - 36} ${mid.x} ${mid.y - 18}" />`
    : '';

  // The squat stand sits at the BOTTOM of the rail, which is why stand exercises are head-toward
  // the tower -- drawing it in the wrong place would teach the thing the data used to get wrong.
  const stand =
    exercise.attachment === 'Squat stand'
      ? `<line class="accessory" x1="${RAIL.bottomX + 6}" y1="${RAIL.bottomY - 16}" x2="${RAIL.bottomX + 6}" y2="${RAIL.bottomY + 4}" />`
      : '';

  const wing =
    exercise.attachment === 'Wing attachment'
      ? `<line class="accessory" x1="${RAIL.topX - 8}" y1="${RAIL.topY - 16}" x2="${RAIL.topX + 12}" y2="${RAIL.topY - 16}" />`
      : '';

  const dx = (moved.x - rest.x).toFixed(1);
  const dy = (moved.y - rest.y).toFixed(1);

  return `
    <svg viewBox="0 0 190 120" role="img"
         aria-label="${exercise.name}: ${pose.caption}"
         style="--travel: translate(${dx}px, ${dy}px)">
      <line class="tower" x1="${RAIL.topX}" y1="${RAIL.topY - 20}" x2="${RAIL.topX}" y2="${RAIL.topY + 8}" />
      <line class="rail" x1="${RAIL.topX}" y1="${RAIL.topY}" x2="${RAIL.bottomX}" y2="${RAIL.bottomY}" />
      <line class="rail" x1="${RAIL.bottomX - 14}" y1="${RAIL.bottomY + 8}" x2="${RAIL.bottomX + 14}" y2="${RAIL.bottomY + 8}" />
      ${stand}${wing}${cable}
      <!--
        Two groups, not one. A CSS transform REPLACES an element's transform attribute rather than
        composing with it, so animating the same group that positions the board teleports it to
        the origin -- which is exactly what it did: rail and stand drew, board and trainee did not.
      -->
      <g id="board" transform="translate(${rest.x} ${rest.y})">
        <g class="anim">
          <rect class="board" x="-22" y="-6" width="44" height="8" rx="3" />
          ${figureFor(exercise, pose.limb)}
        </g>
      </g>
    </svg>`;
}

export function demoCaption(exercise: Exercise): string {
  return poseFor(exercise.pattern).caption;
}
