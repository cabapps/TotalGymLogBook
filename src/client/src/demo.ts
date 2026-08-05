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
 * How far the working limb swings, in degrees, and which way.
 *
 * Positive is "away from the body" in the figure's own frame. A press opens the joint, a curl
 * closes it, and the sign is what makes the drawing read as the movement rather than as a limb
 * waving about.
 */
function swingFor(pattern: string): number {
  switch (pattern) {
    case 'press': return -38;
    case 'fly': return -50;
    case 'pulldown': return 55;
    case 'row': return 40;
    case 'curl': return -65;
    case 'extend': return 45;
    case 'raise': return -40;
    case 'squat': return -30;
    case 'hinge': return -25;
    case 'calf': return -14;
    case 'crunch': return 28;
    default: return 0;
  }
}

/**
 * How the middle joint behaves, in degrees: bent by `from` at rest, `to` at the far end.
 *
 * A straight stick for an arm cannot show what a trainee most needs to see -- which joint is
 * supposed to bend. A curl and a press move the same limb through a similar arc, and the only
 * thing that distinguishes them is what the elbow does. So the elbow and the knee are drawn,
 * and they open and close with the movement.
 *
 * Sign is in the limb's own rotated frame: positive folds the far segment toward the figure.
 */
interface Bend {
  readonly from: number;
  readonly to: number;
}

/** Elbow behaviour per pattern. Legs get the knee equivalent below. */
function elbowFor(pattern: string): Bend {
  switch (pattern) {
    // Pressing straightens the arm: bent at the start, locked out at the end.
    case 'press': return { from: 70, to: 8 };
    case 'extend': return { from: 75, to: 5 };
    // Pulling closes it.
    case 'pulldown': return { from: 10, to: 70 };
    case 'row': return { from: 8, to: 75 };
    case 'curl': return { from: 10, to: 95 };
    // A fly and a raise hold a fixed soft bend the whole way -- that IS the technique, and an
    // elbow that opens and shuts through either one is the most common way to do them wrong.
    case 'fly': return { from: 22, to: 22 };
    case 'raise': return { from: 18, to: 18 };
    default: return { from: 15, to: 15 };
  }
}

/** Knee behaviour per pattern. */
function kneeFor(pattern: string): Bend {
  switch (pattern) {
    // The board is at the bottom of the rail with the knees folded, and the rep straightens them.
    case 'squat': return { from: 85, to: 12 };
    case 'hinge': return { from: 40, to: 10 };
    // Ankles only. A knee that bends here is the error the caption warns about.
    case 'calf': return { from: 12, to: 12 };
    case 'crunch': return { from: 55, to: 55 };
    default: return { from: 20, to: 20 };
  }
}

/**
 * A limb that pivots at its joint, with a second segment that pivots at knee or elbow.
 *
 * NESTED GROUPS, and the reason is the bug this replaced. Each group translates to a joint; the
 * group inside it rotates about its own origin, which is now that joint. Animating a limb inside
 * the board's own animated group made it inherit the board's travel AND add its own, so arms and
 * legs slid off the figure entirely -- a leg walking away from a squatting stick man.
 *
 * A rotation cannot detach: whatever the angle, the segment still starts at the joint. The same
 * property is what makes the second segment safe to hang off the first.
 */
function limb(joint: Point, to: Point, moving: boolean, bend: Bend): string {
  const dx = to[0] - joint[0];
  const dy = to[1] - joint[1];

  // The joint sits at the halfway point. Anatomically that is about right for both an arm and a
  // leg, and it saves carrying a third coordinate through every pose.
  const upper = `<line class="figure" x1="0" y1="0" x2="${(dx / 2).toFixed(1)}" y2="${(dy / 2).toFixed(1)}" />`;
  const lower = `<line class="figure" x1="0" y1="0" x2="${(dx / 2).toFixed(1)}" y2="${(dy / 2).toFixed(1)}" />`;

  // A still limb takes the resting angle as an ATTRIBUTE, an animated one as CSS. Never both: a
  // CSS transform replaces the attribute rather than composing with it.
  const flex = moving
    ? `<g class="joint" style="--bend-from: ${bend.from}deg; --bend-to: ${bend.to}deg">${lower}</g>`
    : `<g transform="rotate(${bend.from})">${lower}</g>`;

  return `<g transform="translate(${joint[0]} ${joint[1]})">
            <g class="${moving ? 'limb' : ''}">
              ${upper}
              <g transform="translate(${(dx / 2).toFixed(1)} ${(dy / 2).toFixed(1)})">${flex}</g>
            </g>
          </g>`;
}

export type Point = readonly [number, number];

/**
 * Where every part of the figure is, in board-local coordinates: x runs along the rail, NEGATIVE
 * TOWARD THE TOWER, y is height above the board.
 *
 * Separated from the drawing so it can be asserted rather than eyeballed. Every mistake this
 * drawing has made has been here -- limbs on the wrong side of a joint, a figure facing the wrong
 * way down the rail -- and every one of them survived review because a stick figure looks
 * plausible from any angle if you are not measuring it. The tests measure it now, across the
 * whole catalog, against the setup each movement already declares.
 */
export interface Figure {
  readonly head: Point;
  readonly neck: Point;
  readonly shoulder: Point;
  readonly hip: Point;
  /** Where the working hand ends up. */
  readonly hand: Point;
  /** Where the foot ends up. */
  readonly foot: Point;
  /** +1 when the trainee faces down the rail (away from the tower), -1 toward it. */
  readonly facing: number;
}

export function figureFor(exercise: Exercise): Figure {
  const { position, facing } = exercise.setup;

  // Which way the trainee faces along the rail. Negative x is the tower.
  const hs = facing === 'tower' ? -1 : 1;

  if (position === 'seated' || position === 'kneeling') {
    // SITTING UPRIGHT, LEGS AND ARMS BOTH IN FRONT.
    //
    // This is the bug that shipped three times: legs were drawn on the far side of the hip from
    // the arms, so a chest press -- sitting with your back to the tower, legs down the board --
    // came out as a figure facing the tower with its legs up the rail. Nobody sits with their
    // legs behind them. Both limbs go the way the trainee faces, and that is now asserted.
    return {
      hip: [0, -6],
      neck: [-4 * hs, -26],
      shoulder: [-1 * hs, -23],
      head: [-6 * hs, -31],
      hand: [18 * hs, -18],
      foot: [20 * hs, -2],
      facing: hs,
    };
  }

  if (position === 'face-down') {
    // Prone, head at the end the setup names, arms reaching along the board past the head.
    return {
      hip: [-9 * hs, -8],
      neck: [11 * hs, -9],
      shoulder: [7 * hs, -8],
      head: [16 * hs, -11],
      hand: [15 * hs, -1],
      foot: [-22 * hs, -4],
      facing: hs,
    };
  }

  // Face up, and side-lying, which reads the same from this angle.
  return {
    hip: [-9 * hs, -8],
    neck: [11 * hs, -10],
    shoulder: [7 * hs, -9],
    head: [16 * hs, -12],
    hand: [14 * hs, -26],
    foot: [-24 * hs, -7],
    facing: hs,
  };
}

/**
 * The figure, drawn from its geometry.
 *
 * The upper body hangs off the hip in its own group, which is what lets a crunch rotate all of
 * it -- spine, shoulders, head and arms -- about the hip as one piece. Drawing a second torso
 * line for the curl, which is what this used to do, gave the figure two spines.
 */
function drawFigure(exercise: Exercise, pose: Pose): string {
  const f = figureFor(exercise);
  const arms = pose.limb === 'arms' || pose.limb === 'forearms';
  const elbow = elbowFor(exercise.pattern);
  const knee = kneeFor(exercise.pattern);

  // Everything above the hip, in hip-relative coordinates.
  const at = (p: Point): Point => [p[0] - f.hip[0], p[1] - f.hip[1]];
  const neck = at(f.neck);
  const shoulder = at(f.shoulder);
  const head = at(f.head);

  const upper = `
    <line class="figure" x1="0" y1="0" x2="${neck[0]}" y2="${neck[1]}" />
    <line class="figure" x1="${neck[0]}" y1="${neck[1]}" x2="${shoulder[0]}" y2="${shoulder[1]}" />
    <circle class="head" cx="${head[0]}" cy="${head[1]}" r="4" />
    ${limb(shoulder, at(f.hand), arms, elbow)}`;

  return `
    <g>
      ${limb(f.hip, f.foot, pose.limb === 'legs', knee)}
      <g transform="translate(${f.hip[0]} ${f.hip[1]})">
        <g class="${pose.limb === 'torso' ? 'limb' : ''}">${upper}</g>
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
         style="--travel: translate(${dx}px, ${dy}px); --swing: ${swingFor(exercise.pattern)}deg">
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
          ${drawFigure(exercise, pose)}
        </g>
      </g>
    </svg>`;
}

export function demoCaption(exercise: Exercise): string {
  return poseFor(exercise.pattern).caption;
}
