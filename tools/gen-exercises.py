#!/usr/bin/env python3
"""Regenerates data/exercises.json. Run from the repo root: python3 tools/gen-exercises.py

The generator is the source of truth for the catalog -- editing a hundred entries of hand-indented
JSON by hand is how a stray pulley flag gets in, and a wrong pulley flag halves or doubles the
recorded load for every set of that movement.

Every cue is written from scratch (docs/adr/0004): exercise NAMES are unprotectable short
phrases and the movements are unprotectable methods, but Total Gym's instructional prose and
artwork are theirs. Nothing here is transcribed.
"""
import json, collections

# id, name, category, kind, pulley, bodyFraction, attachment, cue, muscles
E = collections.namedtuple("E", "id name category kind pulley bf att cue muscles")
D, I = 1.0, 0.5  # direct / indirect involvement

# WHERE IN THE RANGE THE MUSCLE IS MOST LOADED.
#
# Everything not listed here is 'even'. Only clear cases are named, because a three-way label
# applied to all hundred movements by guesswork would be worse than no label at all: the program
# builder would then rank exercises on noise.
#
# Why it exists: training a muscle under load while it is LENGTHENED grows it more than the same
# sets taken through a shortened range. The Total Gym is unusually good at this -- a cable holds
# tension at the bottom of a fly where a dumbbell goes slack -- so a hypertrophy program built on
# this machine should lean on it. See docs/adr/0010.
#
# This is a judgment about each movement's mechanics, in the same class as bodyFraction: informed,
# reviewable, and not measured. Getting one wrong changes which exercise the builder suggests
# first, never a recorded number.
LENGTHENED = {
    # Chest: the cable stays taut at the bottom, where the pec is longest.
    "chest-press", "chest-fly", "incline-chest-fly", "chest-crossover",
    "single-arm-chest-press", "shaper-bar-press", "decline-push-up", "chest-dip",
    # Back: lats under load with the arms overhead.
    "pullover", "lat-pulldown", "wide-grip-pulldown", "reverse-grip-pulldown",
    "straight-arm-pulldown", "pull-up", "chin-up", "wide-grip-pull-up",
    # Arms: the long head of the triceps and the biceps, loaded overhead.
    "overhead-triceps-extension", "rope-overhead-extension", "overhead-cable-curl",
    # Legs: the bottom of a squat, and a calf raise off the edge of the stand.
    "squat", "wide-stance-squat", "narrow-stance-squat", "single-leg-squat", "split-squat",
    "hip-bridge", "calf-raise", "single-leg-calf-raise", "pilates-frog",
}

# Load peaks where the muscle is already short. Not bad exercises -- several are the only way to
# reach a muscle on this machine -- but a hypertrophy program should not be built out of them.
SHORTENED = {
    "lateral-raise", "front-raise", "scaption-raise", "shoulder-shrug", "upright-row",
    "reverse-fly", "concentration-curl", "triceps-kickback", "triceps-pushdown",
    "rope-pushdown", "leg-extension", "hamstring-curl", "wing-hamstring-curl",
    "glute-kickback", "side-lying-leg-lift", "hip-adduction",
    "crunch", "cable-crunch", "oblique-crunch", "reverse-crunch", "bicycle-crunch",
    "knee-tuck", "pike", "abcrunch-curl-up", "abcrunch-oblique-twist",
}

# What an exercise REQUIRES. A capability, not a product: two different accessories can satisfy
# the same requirement, which is the whole reason this is a separate vocabulary from the
# accessory list below. See ACCESSORIES.
STAND = "Squat stand"
WING = "Wing attachment"
BARS = "Press-up bars"
DIP = "Dip bars"
LEGPULL = "Leg pull accessory"
ANKLE = "Ankle straps"
ABCRUNCH = "AbCrunch"
PILATES = "Pilates kit"
ROPE = "Triceps rope"
SHAPER = "Shaper bars"

# id, name, provides, ships-with-most-machines, added-in-registry-version, note
A = collections.namedtuple("A", "id name provides common added note")

# The accessories a trainee can own, and what each one lets them do.
#
# TWO LAYERS ON PURPOSE. An exercise names a CAPABILITY ("Wing attachment"); the trainee ticks a
# PRODUCT ("Wing attachment (two-piece)"). Total Gym shipped the wing in a one-piece and a
# two-piece version and they do the same job, so a model where the exercise names the product
# would hide pull-ups from half the owners in the world.
#
# `added` is the registry version an accessory first appeared in, and it exists because this
# list will keep growing. A trainee who ticked their equipment last year answered a shorter
# question than the one being asked now, and their stored answer cannot mean "no" to something
# they were never shown -- accessories newer than the version they answered are treated as
# unanswered, which shows the exercises rather than hiding them. See ExerciseCatalog.resolveOwned.
ACCESSORIES = [
    A("squat-stand", "Squat stand", [STAND], True, 1,
      "Ships with most machines."),
    A("wing-two-piece", "Wing attachment (two-piece)", [WING], True, 2,
      "Ships with most machines -- the two bars that bolt on either side at the top."),
    A("wing-one-piece", "Wing attachment (one-piece)", [WING], True, 2,
      "The single-bar version of the same thing. Either one does every wing exercise."),
    A("press-up-bars", "Press-up bars", [BARS], False, 1, None),
    A("dip-bars", "Dip bars", [DIP], False, 2, None),
    A("leg-pull-accessory", "Leg pull accessory", [LEGPULL], False, 1, None),
    A("ankle-straps", "Ankle straps", [ANKLE], False, 1, None),
    A("ab-crunch", "AbCrunch", [ABCRUNCH], False, 2, None),
    A("pilates-kit", "Pilates kit", [PILATES], False, 2, None),
    A("triceps-rope", "Triceps rope", [ROPE], False, 2, None),
    A("shaper-bars", "Tri-grip shaper bars", [SHAPER], False, 2, None),

    # These two unlock no exercises -- they add load to the ones you already do. They are here
    # because the set logger asks for vest and bar weight on every set, and asking someone who
    # owns neither is two fields of noise on the one screen that has to stay fast.
    A("weight-vest", "Weighted vest", [], False, 3,
      "Adds load to any exercise. Discounted by the incline -- 10 lb at level 8 is about 3 lb."),
    A("weight-bar", "Weight bar", [], False, 3,
      "Bolts to the glideboard, so its weight is not discounted the way a vest is."),
]

# HOW THE TRAINEE IS ARRANGED ON THE MACHINE.
#
# Two jobs, one table. It is what the app tells the trainee about setting the movement up
# (position, which way they face, what they hold), and it is what decides which movements can be
# done back to back without rebuilding the machine -- the Total Gym's actual advantage over a rack
# of separate stations, and the thing that decides whether a session takes 25 minutes or 50.
#
# Keeping both off one table is deliberate. If the ordering thought two movements shared a setup
# while the instructions told the trainee to turn around between them, one of them would be lying,
# and there would be no way to tell which.
#
# NOTHING HAPPENS OFF THE BOARD. Even the dips use it -- there is no standing position, and a
# model with one in it would order sessions around a changeover that does not exist.
#
# position: face-up, face-down, seated, kneeling, side-lying
# facing  : 'tower' (the pulley end, up the incline) or 'floor' (the low end). Lying, that is
#           which way the head points; sitting, it is which way the trainee faces -- and it
#           mostly follows the cable, because you sit facing the tower for what you PULL and away
#           from it for what you PUSH.
# also    : a SECOND facing the movement works at, where one exists. A curl is the clear case:
#           it is fine either way round. This is not a footnote -- it is what lets a curl sit in
#           the middle of a block of pressing without anybody turning around, so it changes the
#           order the session comes out in and not just the wording of the instruction.
# grip    : what is in the hands (or on the ankles)
#
# Every movement is listed. These are judgments about how each is normally performed, in the same
# class as bodyFraction -- reviewable, and wrong only in the direction of a clumsier exercise
# order or an instruction that reads oddly.
SETUP = {
    # ---- lying face up, head toward the tower: arms overhead, cable coming from above
    "pullover": ("face-up", "tower", "handles"),
    "lat-pulldown": ("face-up", "tower", "handles"),
    "wide-grip-pulldown": ("face-up", "tower", "handles, wide"),
    "reverse-grip-pulldown": ("face-up", "tower", "handles, palms up"),
    "straight-arm-pulldown": ("face-up", "tower", "handles"),
    "pullover-to-press": ("face-up", "tower", "handles"),
    "overhead-triceps-extension": ("face-up", "tower", "handles"),
    "rope-overhead-extension": ("face-up", "tower", "rope"),
    "overhead-cable-curl": ("face-up", "tower", "handles"),
    "cable-crunch": ("face-up", "tower", "handles by your head"),
    "pull-up": ("face-up", "tower", "wing bars"),
    "chin-up": ("face-up", "tower", "wing bars, palms toward you"),
    "wide-grip-pull-up": ("face-up", "tower", "wing bars, wide"),
    "hanging-knee-raise": ("face-up", "tower", "wing bars"),
    "abcrunch-curl-up": ("face-up", "tower", "AbCrunch pads"),
    "abcrunch-oblique-twist": ("face-up", "tower", "AbCrunch pads"),
    "hamstring-stretch": ("face-up", "tower", "handles"),
    "lat-stretch": ("face-up", "tower", "handles"),
    "chest-stretch": ("face-up", "tower", "handles"),

    # ---- lying face up, head toward the tower: feet down on the squat stand
    #
    # The stand bolts on at the BOTTOM of the rail, so feet on the stand puts the head at the
    # tower end -- the same way round as the cable work, not the opposite way. An assertion
    # below holds every squat-stand movement to it.
    "squat": ("face-up", "tower", "nothing"),
    "wide-stance-squat": ("face-up", "tower", "nothing"),
    "narrow-stance-squat": ("face-up", "tower", "nothing"),
    "single-leg-squat": ("face-up", "tower", "nothing"),
    "split-squat": ("face-up", "tower", "nothing"),
    "jump-squat": ("face-up", "tower", "nothing"),
    "hip-bridge": ("face-up", "tower", "nothing"),
    "calf-raise": ("face-up", "tower", "nothing"),
    "single-leg-calf-raise": ("face-up", "tower", "nothing"),
    "toe-press": ("face-up", "tower", "nothing"),
    "sprinter-start": ("face-up", "tower", "nothing"),
    "board-burpee": ("face-up", "tower", "nothing"),
    "adductor-stretch": ("face-up", "tower", "nothing"),
    "calf-stretch": ("face-up", "tower", "nothing"),
    "crunch": ("face-up", "floor", "nothing"),
    "oblique-crunch": ("face-up", "floor", "nothing"),
    "reverse-crunch": ("face-up", "floor", "nothing"),
    "bicycle-crunch": ("face-up", "floor", "nothing"),
    "glute-stretch": ("face-up", "floor", "nothing"),
    "spinal-twist": ("face-up", "floor", "nothing"),
    "pilates-footwork": ("face-up", "floor", "nothing"),
    "pilates-frog": ("face-up", "floor", "nothing"),
    "pilates-leg-circle": ("face-up", "floor", "nothing"),
    "pilates-scooter": ("face-up", "floor", "nothing"),

    # ---- sitting, facing the tower: the cable pulls you toward it, so everything you PULL
    "seated-row": ("seated", "tower", "handles"),
    "wide-grip-row": ("seated", "tower", "handles, wide"),
    "high-row": ("seated", "tower", "handles"),
    "low-row": ("seated", "tower", "handles"),
    "single-arm-row": ("seated", "tower", "single handle"),
    "reverse-fly": ("seated", "tower", "handles"),
    "upright-row": ("seated", "tower", "handles"),
    "shoulder-shrug": ("seated", "tower", "handles"),
    "row-to-curl": ("seated", "tower", "handles", "floor"),
    "shaper-bar-row": ("seated", "tower", "shaper bars"),
    "rope-face-pull": ("seated", "tower", "rope"),
    "torso-rotation": ("seated", "tower", "handles"),
    "cable-woodchop": ("seated", "tower", "single handle"),
    "external-rotation": ("seated", "tower", "single handle"),
    "internal-rotation": ("seated", "tower", "single handle"),
    "shoulder-stretch": ("seated", "tower", "handles"),
    "biceps-curl": ("seated", "tower", "handles", "floor"),
    "hammer-curl": ("seated", "tower", "handles, palms in", "floor"),
    "reverse-curl": ("seated", "tower", "handles, palms down", "floor"),
    "wide-grip-curl": ("seated", "tower", "handles, wide", "floor"),
    "concentration-curl": ("seated", "tower", "single handle"),
    "single-arm-curl": ("seated", "tower", "single handle", "floor"),
    "shaper-bar-curl": ("seated", "tower", "shaper bars", "floor"),
    "rope-hammer-curl": ("seated", "tower", "rope", "floor"),
    "triceps-pushdown": ("seated", "tower", "handles"),
    "rope-pushdown": ("seated", "tower", "rope"),
    # Dips press down on the bars at the tower end; the board still carries you.
    "chest-dip": ("seated", "tower", "dip bars"),
    "upright-dip": ("seated", "tower", "dip bars"),

    # ---- sitting, facing away from the tower: the cable comes from behind, so everything you PUSH
    "chest-press": ("seated", "floor", "handles"),
    "chest-fly": ("seated", "floor", "handles"),
    "incline-chest-fly": ("seated", "floor", "handles"),
    "single-arm-chest-press": ("seated", "floor", "single handle"),
    "close-grip-chest-press": ("seated", "floor", "handles, close"),
    "chest-crossover": ("seated", "floor", "handles"),
    "shaper-bar-press": ("seated", "floor", "shaper bars"),
    "press-to-fly": ("seated", "floor", "handles"),
    "shoulder-press": ("seated", "floor", "handles"),
    "front-raise": ("seated", "floor", "handles"),
    "lateral-raise": ("seated", "floor", "handles"),
    "scaption-raise": ("seated", "floor", "handles"),
    "triceps-extension": ("seated", "floor", "handles"),
    "leg-extension": ("seated", "floor", "ankle straps"),
    "triceps-dip": ("seated", "floor", "press-up bars"),

    # ---- kneeling
    "quad-stretch": ("kneeling", "floor", "nothing"),
    "hip-flexor-stretch": ("kneeling", "floor", "nothing"),
    "triceps-kickback": ("kneeling", "floor", "single handle"),
    "glute-kickback": ("kneeling", "floor", "ankle strap"),

    # ---- face down on the board
    "hamstring-curl": ("face-down", "floor", "ankle straps"),
    "wing-hamstring-curl": ("face-down", "tower", "nothing"),
    "leg-pull": ("face-down", "tower", "leg pull bar"),
    "decline-push-up": ("face-down", "floor", "press-up bars"),
    "knee-tuck": ("face-down", "floor", "nothing"),
    "pike": ("face-down", "floor", "nothing"),
    "mountain-climber": ("face-down", "floor", "nothing"),
    "plank-hold": ("face-down", "floor", "nothing"),

    # ---- on your side
    "side-lying-leg-lift": ("side-lying", "floor", "nothing"),
    "hip-abduction": ("side-lying", "tower", "nothing"),
    "hip-adduction": ("side-lying", "tower", "nothing"),
    "side-plank": ("side-lying", "floor", "nothing"),
}

EX = [
    # ---------------------------------------------------------------- chest
    E("chest-press", "Chest Press", "Chest", "strength", True, 1.0, None,
      "Handles level with your chest, elbows tucked, press until your arms are straight.",
      [("Chest", D), ("Triceps", I), ("Shoulders", I)]),
    E("chest-fly", "Chest Fly", "Chest", "strength", True, 1.0, None,
      "Arms wide with elbows softly bent, sweep the handles together in front of your chest.",
      [("Chest", D), ("Shoulders", I)]),
    E("incline-chest-fly", "Incline Chest Fly", "Chest", "strength", True, 1.0, None,
      "Same sweep as a chest fly, set a notch or two higher so the top of the chest takes more of it.",
      [("Chest", D), ("Shoulders", I)]),
    E("single-arm-chest-press", "Single-Arm Chest Press", "Chest", "strength", True, 1.0, None,
      "Press one handle at a time. Keep both hips flat on the board so you don't twist into it.",
      [("Chest", D), ("Triceps", I), ("Core", I)]),
    E("close-grip-chest-press", "Close-Grip Chest Press", "Chest", "strength", True, 1.0, None,
      "Press with your elbows tucked close to your ribs. Most of the work moves to the triceps.",
      [("Triceps", D), ("Chest", D), ("Shoulders", I)]),
    E("chest-crossover", "Chest Crossover", "Chest", "strength", True, 1.0, None,
      "Fly the handles together and let your hands cross past each other at the top.",
      [("Chest", D), ("Shoulders", I)]),
    E("pullover", "Pullover", "Chest", "strength", True, 1.0, None,
      "Arms straight overhead, pull the handles down over your chest in a wide arc.",
      [("Back", D), ("Chest", I), ("Triceps", I)]),
    E("decline-push-up", "Decline Push-Up", "Chest", "strength", False, 1.0, BARS,
      "Face down with your head lower than your feet, hands on the bars, press the board away.",
      [("Chest", D), ("Triceps", I), ("Core", I)]),
    E("shaper-bar-press", "Shaper Bar Chest Press", "Chest", "strength", True, 1.0, SHAPER,
      "Press with the shaper bars in a neutral grip. Easier on the shoulders than a flat grip.",
      [("Chest", D), ("Triceps", I), ("Shoulders", I)]),
    E("chest-dip", "Chest Dip", "Chest", "strength", False, 1.0, DIP,
      "On the dip bars with your chest leaning forward, lower until you feel a stretch and press back up.",
      [("Chest", D), ("Triceps", D), ("Shoulders", I)]),

    # ---------------------------------------------------------------- back
    E("lat-pulldown", "Lat Pulldown", "Back", "strength", True, 1.0, None,
      "Reach overhead and pull the handles down past your shoulders, leading with your elbows.",
      [("Back", D), ("Biceps", I)]),
    E("wide-grip-pulldown", "Wide-Grip Pulldown", "Back", "strength", True, 1.0, None,
      "A pulldown with your hands set wide. Pull your elbows down and out to the sides.",
      [("Back", D), ("Shoulders", I), ("Biceps", I)]),
    E("reverse-grip-pulldown", "Reverse-Grip Pulldown", "Back", "strength", True, 1.0, None,
      "Pull down with your palms facing you. The biceps get a full share of this one.",
      [("Back", D), ("Biceps", D)]),
    E("straight-arm-pulldown", "Straight-Arm Pulldown", "Back", "strength", True, 1.0, None,
      "Keep your arms straight and sweep the handles from overhead down to your hips.",
      [("Back", D), ("Triceps", I)]),
    E("seated-row", "Seated Row", "Back", "strength", True, 0.85, None,
      "Sit upright, pull the handles to your waist and squeeze your shoulder blades together.",
      [("Back", D), ("Biceps", I), ("Shoulders", I)]),
    E("wide-grip-row", "Wide-Grip Row", "Back", "strength", True, 0.85, None,
      "Row with your hands wide and your elbows flared out, finishing at the ribs.",
      [("Back", D), ("Shoulders", I)]),
    E("high-row", "High Row", "Back", "strength", True, 0.85, None,
      "Row towards your collarbones with your elbows high. Upper back and rear shoulders.",
      [("Back", D), ("Shoulders", I)]),
    E("low-row", "Low Row", "Back", "strength", True, 0.85, None,
      "Row low and tight to your body, finishing at the hips with elbows brushing your sides.",
      [("Back", D), ("Biceps", I)]),
    E("single-arm-row", "Single-Arm Row", "Back", "strength", True, 0.85, None,
      "Row one handle at a time. Resist the pull to rotate; that is the core's job here.",
      [("Back", D), ("Biceps", I), ("Core", I)]),
    E("reverse-fly", "Reverse Fly", "Back", "strength", True, 0.85, None,
      "Arms out in front, sweep them wide and back. Small movement, rear shoulders and upper back.",
      [("Shoulders", D), ("Back", D)]),
    E("pull-up", "Pull-Up", "Back", "strength", False, 1.0, WING,
      "Grip the wing bars overhead and pull your chest towards them. The incline sets how hard it is.",
      [("Back", D), ("Biceps", I)]),
    E("chin-up", "Chin-Up", "Back", "strength", False, 1.0, WING,
      "Pull-up with your palms facing you, which brings the biceps in properly.",
      [("Back", D), ("Biceps", D)]),
    E("wide-grip-pull-up", "Wide-Grip Pull-Up", "Back", "strength", False, 1.0, WING,
      "Hands at the far ends of the wing, pull up leading with your elbows out to the sides.",
      [("Back", D), ("Shoulders", I), ("Biceps", I)]),
    E("shaper-bar-row", "Shaper Bar Row", "Back", "strength", True, 0.85, SHAPER,
      "Row with the shaper bars in a neutral grip, palms facing each other, elbows past your ribs.",
      [("Back", D), ("Biceps", I)]),
    E("rope-face-pull", "Rope Face Pull", "Back", "strength", True, 0.85, ROPE,
      "Pull the rope towards your forehead, splitting the ends apart as your elbows come back.",
      [("Shoulders", D), ("Back", D)]),

    # ---------------------------------------------------------------- shoulders
    E("shoulder-press", "Shoulder Press", "Shoulders", "strength", True, 0.85, None,
      "Sit upright, handles at shoulder height, press straight overhead.",
      [("Shoulders", D), ("Triceps", I)]),
    E("front-raise", "Front Raise", "Shoulders", "strength", True, 0.85, None,
      "Arms straight, raise the handles in front of you to about eye level.",
      [("Shoulders", D)]),
    E("lateral-raise", "Lateral Raise", "Shoulders", "strength", True, 0.85, None,
      "Arms straight, raise the handles out to the sides until they're level with your shoulders.",
      [("Shoulders", D)]),
    E("scaption-raise", "Scaption Raise", "Shoulders", "strength", True, 0.85, None,
      "Raise the handles halfway between straight ahead and straight out. Kinder on the shoulder joint.",
      [("Shoulders", D)]),
    E("upright-row", "Upright Row", "Shoulders", "strength", True, 0.85, None,
      "Pull the handles up along your body to chest height, elbows leading and above your wrists.",
      [("Shoulders", D), ("Back", I), ("Biceps", I)]),
    E("shoulder-shrug", "Shoulder Shrug", "Shoulders", "strength", True, 0.85, None,
      "Arms straight, lift your shoulders towards your ears without bending your elbows.",
      [("Shoulders", D), ("Back", I)]),
    E("external-rotation", "External Rotation", "Shoulders", "strength", True, 0.85, None,
      "Elbow tucked at your side and bent, rotate your forearm outwards. Light loads, this is rotator cuff work.",
      [("Shoulders", D)]),
    E("internal-rotation", "Internal Rotation", "Shoulders", "strength", True, 0.85, None,
      "Elbow tucked and bent, rotate your forearm across your body. Light loads.",
      [("Shoulders", D)]),

    # ---------------------------------------------------------------- biceps
    E("biceps-curl", "Biceps Curl", "Arms", "strength", True, 0.85, None,
      "Sit upright, elbows fixed at your sides, curl the handles up to your shoulders.",
      [("Biceps", D)]),
    E("hammer-curl", "Hammer Curl", "Arms", "strength", True, 0.85, None,
      "Curl with your palms facing each other the whole way, like holding a hammer.",
      [("Biceps", D)]),
    E("reverse-curl", "Reverse Curl", "Arms", "strength", True, 0.85, None,
      "Curl with your palms facing down. Harder than it looks, and it hits the forearms.",
      [("Biceps", D)]),
    E("wide-grip-curl", "Wide-Grip Curl", "Arms", "strength", True, 0.85, None,
      "Curl with your hands set wide and elbows out slightly.",
      [("Biceps", D)]),
    E("concentration-curl", "Concentration Curl", "Arms", "strength", True, 0.85, None,
      "One arm, elbow braced against your inner thigh, curl slowly and don't swing.",
      [("Biceps", D)]),
    E("single-arm-curl", "Single-Arm Curl", "Arms", "strength", True, 0.85, None,
      "Curl one handle at a time and keep your shoulders square as you do it.",
      [("Biceps", D), ("Core", I)]),
    E("overhead-cable-curl", "Overhead Cable Curl", "Arms", "strength", True, 1.0, None,
      "Lie back with the cables coming from above your head and curl towards your forehead, elbows still.",
      [("Biceps", D)]),
    E("rope-hammer-curl", "Rope Hammer Curl", "Arms", "strength", True, 0.85, ROPE,
      "Curl the rope with your palms facing each other and pull the ends apart at the top.",
      [("Biceps", D)]),
    E("shaper-bar-curl", "Shaper Bar Curl", "Arms", "strength", True, 0.85, SHAPER,
      "Curl the shaper bars with your elbows pinned. The grip angle takes the strain off your wrists.",
      [("Biceps", D)]),

    # ---------------------------------------------------------------- triceps
    E("triceps-extension", "Triceps Extension", "Arms", "strength", True, 0.85, None,
      "Elbows high and still, straighten your arms against the cable.",
      [("Triceps", D)]),
    E("triceps-pushdown", "Triceps Pushdown", "Arms", "strength", True, 0.85, None,
      "Elbows pinned to your sides, push the handles down until your arms lock out.",
      [("Triceps", D)]),
    E("overhead-triceps-extension", "Overhead Triceps Extension", "Arms", "strength", True, 1.0, None,
      "Lie back with the handles behind your head, straighten your arms without moving your elbows.",
      [("Triceps", D)]),
    E("triceps-kickback", "Triceps Kickback", "Arms", "strength", True, 0.85, None,
      "Upper arm still and parallel to the board, straighten your elbow behind you.",
      [("Triceps", D)]),
    E("triceps-dip", "Triceps Dip", "Arms", "strength", False, 1.0, BARS,
      "Hands on the bars behind you, lower until your elbows are bent, then press back up.",
      [("Triceps", D), ("Chest", I), ("Shoulders", I)]),
    E("upright-dip", "Upright Dip", "Arms", "strength", False, 1.0, DIP,
      "On the dip bars with your torso upright and elbows tracking straight back. Triceps take it.",
      [("Triceps", D), ("Chest", I), ("Shoulders", I)]),
    E("rope-pushdown", "Rope Pushdown", "Arms", "strength", True, 0.85, ROPE,
      "Elbows at your sides, push the rope down and spread the ends apart as your arms lock out.",
      [("Triceps", D)]),
    E("rope-overhead-extension", "Overhead Rope Extension", "Arms", "strength", True, 1.0, ROPE,
      "Rope behind your head, elbows high and still, straighten your arms and split the ends.",
      [("Triceps", D)]),

    # ---------------------------------------------------------------- legs
    E("squat", "Squat", "Legs", "strength", False, 1.0, STAND,
      "Feet flat on the squat stand, lower until your knees are bent, then drive the board back up.",
      [("Quadriceps", D), ("Glutes", D), ("Hamstrings", I)]),
    E("wide-stance-squat", "Wide-Stance Squat", "Legs", "strength", False, 1.0, STAND,
      "Squat with your feet wide and toes turned out. More glute and inner thigh.",
      [("Quadriceps", D), ("Glutes", D), ("Adductors", I)]),
    E("narrow-stance-squat", "Narrow-Stance Squat", "Legs", "strength", False, 1.0, STAND,
      "Squat with your feet close together. The quads take most of it.",
      [("Quadriceps", D), ("Glutes", I)]),
    E("single-leg-squat", "Single-Leg Squat", "Legs", "strength", False, 1.0, STAND,
      "One foot on the stand, the other tucked away. Keep your knee tracking over your toes.",
      [("Quadriceps", D), ("Glutes", D), ("Hamstrings", I)]),
    E("split-squat", "Split Squat", "Legs", "strength", False, 1.0, STAND,
      "One foot high on the stand and one low, lower and drive back up without shifting your weight.",
      [("Quadriceps", D), ("Glutes", D)]),
    E("jump-squat", "Jump Squat", "Legs", "strength", False, 1.0, STAND,
      "Squat down and push off hard enough that your feet leave the stand. Land soft.",
      [("Quadriceps", D), ("Glutes", D), ("Calves", I)]),
    E("hip-bridge", "Hip Bridge", "Legs", "strength", False, 1.0, STAND,
      "Feet on the stand, drive your hips up until your body is a straight line, then lower.",
      [("Glutes", D), ("Hamstrings", D)]),
    E("calf-raise", "Calf Raise", "Legs", "strength", False, 1.0, STAND,
      "Balls of your feet on the edge of the stand, press up onto your toes and lower slowly.",
      [("Calves", D)]),
    E("single-leg-calf-raise", "Single-Leg Calf Raise", "Legs", "strength", False, 1.0, STAND,
      "One foot on the edge of the stand, press up onto your toes and lower under control.",
      [("Calves", D)]),
    E("toe-press", "Toe Press", "Legs", "strength", False, 1.0, STAND,
      "Legs almost straight, push the board using only your ankles.",
      [("Calves", D)]),
    E("hip-abduction", "Hip Abduction", "Legs", "strength", False, 1.0, STAND,
      "Lie on your side and press the board away with the top leg, opening the hip.",
      [("Glutes", D), ("Quadriceps", I)]),
    E("hip-adduction", "Hip Adduction", "Legs", "strength", False, 1.0, STAND,
      "Lie on your side and press with the bottom leg, drawing it in towards the midline.",
      [("Adductors", D), ("Glutes", I)]),
    E("side-lying-leg-lift", "Side-Lying Leg Lift", "Legs", "strength", False, 1.0, None,
      "On your side, lift the top leg against the incline. Small, controlled, no swinging.",
      [("Glutes", D)]),
    E("hamstring-curl", "Hamstring Curl", "Legs", "strength", True, 1.0, ANKLE,
      "Face down with the straps on your ankles, bend your knees to draw your heels towards you.",
      [("Hamstrings", D), ("Glutes", I)]),
    # The wing version is a different exercise, not a re-labeling of the cable one: no pulley, so
    # the load is roughly double. Kept separate because changing the cable version's physics
    # would put a step change in the middle of anyone's logged history for it.
    E("wing-hamstring-curl", "Wing Hamstring Curl", "Legs", "strength", False, 1.0, WING,
      "Face down with your heels hooked on the wing, bend your knees to pull the board up the rail.",
      [("Hamstrings", D), ("Glutes", I)]),
    E("leg-extension", "Leg Extension", "Legs", "strength", True, 0.85, ANKLE,
      "Seated with the straps on your ankles, straighten your knees against the cable.",
      [("Quadriceps", D)]),
    E("glute-kickback", "Glute Kickback", "Legs", "strength", True, 1.0, ANKLE,
      "Strap on one ankle, push that leg back and up without arching your lower back.",
      [("Glutes", D), ("Hamstrings", I)]),

    # ---------------------------------------------------------------- core
    E("crunch", "Crunch", "Core", "strength", False, 0.75, None,
      "Lie back on the board and curl your ribs towards your hips. Short range, no pulling on your neck.",
      [("Core", D)]),
    E("cable-crunch", "Cable Crunch", "Core", "strength", True, 0.85, None,
      "Hold the handles by your head and crunch down against the cable.",
      [("Core", D)]),
    E("oblique-crunch", "Oblique Crunch", "Core", "strength", False, 0.75, None,
      "Crunch up and across, taking one shoulder towards the opposite hip.",
      [("Core", D)]),
    E("reverse-crunch", "Reverse Crunch", "Core", "strength", False, 0.9, None,
      "Knees bent, curl your hips up off the board. The legs stay passive.",
      [("Core", D)]),
    E("bicycle-crunch", "Bicycle Crunch", "Core", "strength", False, 0.75, None,
      "Alternate elbow to opposite knee, extending the other leg as you go.",
      [("Core", D)]),
    E("knee-tuck", "Knee Tuck", "Core", "strength", False, 1.0, None,
      "Face down in a plank on the board, draw both knees up towards your chest.",
      [("Core", D), ("Quadriceps", I)]),
    E("pike", "Pike", "Core", "strength", False, 1.0, None,
      "From the same plank, keep your legs straight and lift your hips towards the ceiling.",
      [("Core", D), ("Shoulders", I)]),
    E("plank-hold", "Plank Hold", "Core", "strength", False, 1.0, None,
      "Forearms on the board, body in a straight line, and hold. Count time, not reps.",
      [("Core", D), ("Shoulders", I)]),
    E("side-plank", "Side Plank", "Core", "strength", False, 1.0, None,
      "One forearm down, hips stacked and lifted. Hold, then swap sides.",
      [("Core", D)]),
    E("hanging-knee-raise", "Hanging Knee Raise", "Core", "strength", False, 1.0, WING,
      "Hold the wing overhead and draw your knees up towards your chest.",
      [("Core", D)]),
    E("abcrunch-curl-up", "AbCrunch Curl-Up", "Core", "strength", False, 1.0, ABCRUNCH,
      "Head towards the top, arms hooked over the pads, curl your ribs down and let the board follow.",
      [("Core", D)]),
    E("abcrunch-oblique-twist", "AbCrunch Oblique Twist", "Core", "strength", False, 1.0, ABCRUNCH,
      "Same curl-up, but drive one shoulder across towards the opposite hip. Alternate sides.",
      [("Core", D)]),
    E("leg-pull", "Leg Pull", "Core", "strength", True, 0.9, LEGPULL,
      "Feet in the accessory, pull your legs down and in against the cable.",
      [("Core", D), ("Quadriceps", I)]),
    E("torso-rotation", "Torso Rotation", "Core", "strength", True, 0.85, None,
      "Arms out in front, rotate your ribcage away from the cable and return slowly.",
      [("Core", D)]),
    E("cable-woodchop", "Cable Woodchop", "Core", "strength", True, 0.85, None,
      "Pull the handle diagonally across your body, high to low, turning through the trunk.",
      [("Core", D), ("Shoulders", I)]),

    # ---------------------------------------------------------------- total body
    E("pullover-to-press", "Pullover to Press", "Total body", "strength", True, 1.0, None,
      "Pull over from overhead, then press straight up from your chest. One rep is both halves.",
      [("Back", D), ("Chest", D), ("Triceps", I)]),
    E("row-to-curl", "Row to Curl", "Total body", "strength", True, 0.85, None,
      "Row to your waist, then curl the handles up to your shoulders before lowering.",
      [("Back", D), ("Biceps", D)]),
    E("press-to-fly", "Press to Fly", "Total body", "strength", True, 1.0, None,
      "Press up, then open your arms wide and sweep them back together.",
      [("Chest", D), ("Shoulders", I), ("Triceps", I)]),
    E("mountain-climber", "Mountain Climber", "Total body", "strength", False, 1.0, None,
      "Plank on the board, drive one knee up at a time at a steady pace.",
      [("Core", D), ("Shoulders", I), ("Quadriceps", I)]),
    E("board-burpee", "Board Burpee", "Total body", "strength", False, 1.0, STAND,
      "Tuck your knees in, press the board out to a plank, then pull back and drive out through your feet.",
      [("Quadriceps", D), ("Core", D), ("Chest", I)]),
    E("sprinter-start", "Sprinter Start", "Total body", "strength", False, 1.0, STAND,
      "One foot loaded on the stand, drive it out explosively and return under control.",
      [("Quadriceps", D), ("Glutes", D), ("Calves", I)]),

    # ---------------------------------------------------------------- pilates
    E("pilates-footwork", "Pilates Footwork", "Pilates", "strength", False, 1.0, PILATES,
      "Toes on the bar, heels lifted, press the board away and return slowly under control.",
      [("Quadriceps", D), ("Calves", D), ("Glutes", I)]),
    E("pilates-frog", "Pilates Frog", "Pilates", "strength", False, 1.0, PILATES,
      "Heels together and knees open, press out until your legs are straight, then fold back in.",
      [("Quadriceps", D), ("Glutes", D), ("Adductors", I)]),
    E("pilates-leg-circle", "Pilates Leg Circle", "Pilates", "strength", False, 1.0, PILATES,
      "Legs straight against the bar, trace a slow circle without letting your hips rock.",
      [("Glutes", D), ("Adductors", D), ("Core", I)]),
    E("pilates-scooter", "Pilates Scooter", "Pilates", "strength", False, 1.0, PILATES,
      "One foot on the bar and one leg free, push the board away with the working leg only.",
      [("Glutes", D), ("Quadriceps", I), ("Core", I)]),

    # ---------------------------------------------------------------- stretch
    E("hamstring-stretch", "Hamstring Stretch", "Stretch", "stretch", True, 1.0, None,
      "Lie back, straighten one leg towards the ceiling and draw it gently in. Hold and breathe.",
      [("Hamstrings", D)]),
    E("quad-stretch", "Quad Stretch", "Stretch", "stretch", False, 1.0, None,
      "Kneel on the board and ease your hips forward until you feel the front of the thigh open.",
      [("Quadriceps", D)]),
    E("hip-flexor-stretch", "Hip Flexor Stretch", "Stretch", "stretch", False, 1.0, None,
      "Half-kneeling, let the incline carry your hips forward. Front of the hip, not the lower back.",
      [("Quadriceps", D)]),
    E("glute-stretch", "Glute Stretch", "Stretch", "stretch", False, 1.0, None,
      "Ankle crossed over the opposite knee, draw both legs in towards your chest.",
      [("Glutes", D)]),
    E("adductor-stretch", "Inner Thigh Stretch", "Stretch", "stretch", False, 1.0, STAND,
      "Feet wide on the stand, let your knees ease apart and hold where it's comfortable.",
      [("Adductors", D)]),
    E("calf-stretch", "Calf Stretch", "Stretch", "stretch", False, 1.0, STAND,
      "Ball of one foot on the edge of the stand, let the heel drop and hold.",
      [("Calves", D)]),
    E("chest-stretch", "Chest Stretch", "Stretch", "stretch", True, 1.0, None,
      "Arms wide with the handles, let them draw your chest open. Stop well short of pain.",
      [("Chest", D)]),
    E("lat-stretch", "Lat Stretch", "Stretch", "stretch", True, 1.0, None,
      "Reach overhead, hold the handles and let your ribs lengthen away from your hips.",
      [("Back", D)]),
    E("shoulder-stretch", "Shoulder Stretch", "Stretch", "stretch", True, 1.0, None,
      "One arm across your body, use the other to draw it in until the back of the shoulder opens.",
      [("Shoulders", D)]),
    E("spinal-twist", "Spinal Twist", "Stretch", "stretch", False, 1.0, None,
      "Lie back, drop both knees to one side and keep both shoulders on the board.",
      [("Core", D)]),
]

COMMENT = [
    "Total Gym exercise catalog. See docs/adr/0004 for the copyright position.",
    "",
    "Exercise NAMES are unprotectable short phrases (37 C.F.R. 202.1(a)) and the movements",
    "themselves are unprotectable systems or methods (Bikram's Yoga College v. Evolation Yoga,",
    "9th Cir. 2015). What IS protected is Total Gym's photography, illustration, and",
    "instructional prose -- so every 'cue' line here is written from scratch and no artwork is",
    "reproduced.",
    "",
    "NOT A TRANSCRIPTION OF THE TRAINING DECK. Total Gym sells a deck of 80 exercise cards, and",
    "no public source enumerates it. This catalog is built from the movements the machine",
    "actually supports, organized under the same categories the deck advertises (chest, back,",
    "shoulders, arms, legs, abs, total body, stretch). Overlap is inevitable and expected -- a",
    "chest press is a chest press -- but the selection here is ours and the card numbering is",
    "not reproduced.",
    "",
    "ACCESSORIES ARE A SEPARATE VOCABULARY from what an exercise requires. An exercise names a",
    "capability ('Wing attachment'); the trainee owns a product ('Wing attachment (two-piece)').",
    "Total Gym shipped the wing as one piece and as two, and both do every wing exercise, so an",
    "exercise that named the product would hide pull-ups from half the owners in the world.",
    "",
    "accessories[].added is the registry version the accessory first appeared in. A trainee who",
    "ticked their equipment before it existed answered a shorter question than the one being",
    "asked now, and silence is not a 'no' -- anything newer than the version they answered shows",
    "its exercises until they say otherwise. See ExerciseCatalog.resolveOwned.",
    "",
    "category    : grouping for the exercise picker. Presentation only.",
    "kind        : 'strength' counts toward weekly training volume; 'stretch' does not. Without",
    "              this, adding stretches would silently inflate every muscle's set count and",
    "              make the coach's volume advice wrong (docs/adr/0010).",
    "usesPulley  : true when the movement routes through the cable, which halves the load.",
    "setup       : how the trainee is arranged on the machine -- position, which end of the rail",
    "              they face ('tower' is the pulley end), and what is in their hands. Drives both",
    "              the setup instructions and the session ordering, because two movements that",
    "              share a setup can be done back to back without rebuilding the machine.",
    "              alsoFacing names a second direction the movement works at, where one exists --",
    "              a curl is fine either way round. That is not a footnote: it lets a curl sit in",
    "              a block of pressing without anybody turning around.",
    "peakTension : where in the range the muscle is most loaded -- 'lengthened', 'even', or",
    "              'shortened'. Loaded work at long muscle lengths grows a muscle more than the",
    "              same sets through a shortened range, and a cable machine holds tension at the",
    "              bottom of a fly where a dumbbell goes slack, so a hypertrophy program built on",
    "              this machine should lean on it (docs/adr/0010). A JUDGMENT about mechanics, in",
    "              the same class as bodyFraction: it changes which exercise gets suggested first,",
    "              never a recorded number.",
    "bodyFraction: share of bodyweight actually riding the glideboard. Supine work is ~1.0;",
    "              seated and kneeling positions put less of the trainee on the board.",
    "              THESE ARE ESTIMATES, not measurements -- see the open item in docs/adr/README.",
    "              Getting them wrong shifts absolute load but not progression, because every",
    "              set for an exercise uses the same figure.",
    "muscles     : fraction 1.0 = prime mover, 0.5 = meaningful secondary involvement.",
    "              Fractional accounting matters because Total Gym work is almost all compound;",
    "              see docs/adr/0010.",
]

def setup_of(e):
    """Position, facing and grip. Every movement is listed explicitly."""
    entry = SETUP[e.id]
    position, facing, grip = entry[0], entry[1], entry[2]
    setup = {"position": position, "facing": facing, "grip": grip}
    if len(entry) > 3:
        setup["alsoFacing"] = entry[3]
    return setup


def peak(exercise_id):
    if exercise_id in LENGTHENED:
        return "lengthened"
    return "shortened" if exercise_id in SHORTENED else "even"


def main():
    seen = set()
    for e in EX:
        assert e.id not in seen, f"duplicate id {e.id}"
        seen.add(e.id)
        assert e.cue and e.cue[0].isupper() and e.cue.endswith("."), e.id
        assert e.muscles, e.id

    # Every capability an exercise asks for must be something a trainee can actually tick, or
    # the exercise is unreachable for everyone -- invisible in the picker with no way to fix it.
    provided = {c for a in ACCESSORIES for c in a.provides}
    required = {e.att for e in EX if e.att is not None}
    assert required <= provided, f"no accessory provides {sorted(required - provided)}"
    # An accessory may unlock nothing (a vest adds load to exercises that already exist), but a
    # capability nothing provides is an exercise no trainee can ever reach.
    assert provided <= required, f"accessory provides nothing usable: {sorted(provided - required)}"

    ids = set()
    for a in ACCESSORIES:
        assert a.id not in ids, f"duplicate accessory id {a.id}"
        ids.add(a.id)

    # A tension label on an id that no longer exists is a silent no-op, and the exercise it was
    # meant for quietly reverts to 'even' -- so the program builder stops recommending it and
    # nothing anywhere says why.
    # The squat stand bolts on at the bottom of the rail. Feet on the stand therefore means head
    # at the tower end, always -- a physical fact about the machine rather than a judgment, so it
    # is asserted rather than left to whoever edits the table next.
    wrong_way = [e.id for e in EX if e.att == STAND and setup_of(e)["facing"] != "tower"]
    assert not wrong_way, f"squat-stand movements must face the tower: {sorted(wrong_way)}"

    stray_setup = set(SETUP) - seen
    assert not stray_setup, f"setup for unknown exercises: {sorted(stray_setup)}"

    # Every movement must say how it is set up, or the trainee is told less about it than about
    # the one next to it, and the session ordering has to guess where they are standing.
    missing = [e.id for e in EX if e.id not in SETUP]
    assert not missing, f"no setup recorded for: {sorted(missing)}"

    stray = (LENGTHENED | SHORTENED) - seen
    assert not stray, f"tension labels for unknown exercises: {sorted(stray)}"
    assert not (LENGTHENED & SHORTENED), sorted(LENGTHENED & SHORTENED)

    doc = {
        "$comment": COMMENT,
        "version": 3,
        "accessories": [
            {
                "id": a.id,
                "name": a.name,
                "provides": a.provides,
                "common": a.common,
                "added": a.added,
                **({"note": a.note} if a.note else {}),
            }
            for a in ACCESSORIES
        ],
        "exercises": [
            {
                "id": e.id,
                "name": e.name,
                "category": e.category,
                "kind": e.kind,
                "usesPulley": e.pulley,
                "peakTension": peak(e.id),
                "setup": setup_of(e),
                "bodyFraction": e.bf,
                "attachment": e.att,
                "cue": e.cue,
                "muscles": [{"muscle": m, "fraction": f} for m, f in e.muscles],
            }
            for e in EX
        ],
    }

    with open("data/exercises.json", "w") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")

    by_cat = collections.Counter(e.category for e in EX)
    print(f"{len(EX)} exercises, {len(ACCESSORIES)} accessories")
    for cat, n in by_cat.items():
        print(f"  {cat:12} {n}")

    by_att = collections.Counter(e.att or "(none needed)" for e in EX)
    for att, n in sorted(by_att.items()):
        print(f"  {att:24} {n}")

if __name__ == "__main__":
    main()
