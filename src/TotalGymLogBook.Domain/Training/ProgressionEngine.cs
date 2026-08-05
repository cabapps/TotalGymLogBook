namespace TotalGymLogBook.Domain.Training;

/// <summary>
/// One completed working set, as recorded.
///
/// <see cref="PulleyFactor"/> and <see cref="BodyFraction"/> come from the frozen snapshot on
/// the stored row (docs/adr/0004). They are here because a load ladder built without them
/// describes a different exercise: chest press through the cable at level 8 is 28.4 lb, while
/// the same notch pressed directly off the board is 56.7 lb. Recommending against the wrong
/// ladder tells the trainee to double their load.
/// </summary>
public enum BodySide
{
    Left,
    Right
}

public sealed record SetRecord(
    DateOnly On,
    int Reps,
    double ComputedLb,
    int Level,
    double VestLb = 0,
    double BarLb = 0,
    double PulleyFactor = 1.0,
    double BodyFraction = 1.0,
    /// <summary>
    /// Which side this set trained, for one-limb movements. Null on a two-limb movement, and
    /// null on unilateral sets logged before the app asked -- which is not the same as "both".
    /// </summary>
    BodySide? Side = null)
{
    public bool UsesPulley => PulleyFactor < 1.0;
}

public sealed record ExerciseHistory(string ExerciseId, IReadOnlyList<SetRecord> Sets)
{
    public static ExerciseHistory Empty(string exerciseId) => new(exerciseId, []);

    /// <summary>Sets from the most recent day this exercise was trained.</summary>
    public IReadOnlyList<SetRecord> LastSession
    {
        get
        {
            if (Sets.Count == 0) return [];
            var last = Sets.Max(s => s.On);
            return Sets.Where(s => s.On == last).OrderBy(s => s.Reps).ToList();
        }
    }
}

public enum ProgressionLever
{
    /// <summary>Nothing logged yet.</summary>
    StartingPoint,

    /// <summary>Stay put and add reps before touching the load.</summary>
    AddReps,

    /// <summary>Move up a notch.</summary>
    IncreaseLevel,

    /// <summary>Vest or bar, because a level step would be too big a jump (or none is left).</summary>
    AddWeight,

    /// <summary>Bodyweight fell, so the same level now yields less. Restore the load.</summary>
    CompensateBodyweight,

    /// <summary>Deliberately not progressing: rehab, or a deficit where holding is the win.</summary>
    Hold
}

public sealed record Recommendation(
    int Level,
    double VestLb,
    double BarLb,
    double TargetLb,
    int TargetReps,
    int Sets,
    ProgressionLever Lever,
    string Rationale)
{
    public double AddedLb => VestLb + BarLb;
}

/// <summary>
/// Tier 0 of the coach: deterministic, offline, and always available. It produces the numbers;
/// higher tiers only narrate them, and never override a computed progression (docs/adr/0007).
///
/// The interesting decision here is not "add load" but WHICH LEVER, because a Total Gym has
/// three and they are not interchangeable:
///
///   - Level steps are near-uniform in pounds but not in percentage. At the bottom of a
///     14-notch rail a single notch is a 21% jump; at the top it is 6%. So the "prefer level
///     increases" rule has an exception at BOTH ends, not just at the ceiling.
///   - Added weight is heavily discounted by the incline: a 10 lb vest at 16.5 degrees is
///     worth 2.8 lb, halved again on a cable exercise.
///   - Bodyweight change moves the load underneath the user in either direction.
///
/// See docs/adr/0004 and docs/adr/0010.
/// </summary>
public sealed class ProgressionEngine
{
    /// <summary>A level jump larger than this is too coarse; bridge it with added weight
    /// instead. Derived from the step percentages rather than hardcoded level numbers, so it
    /// holds on any rail profile.</summary>
    public const double MaxLevelStepFraction = 0.15;

    /// <summary>How close a rung must land to the target to count as hitting it.</summary>
    public const double TargetToleranceLb = 0.75;

    public const int DefaultSets = 3;

    public Recommendation NextSession(
        ExerciseHistory history,
        TrainingGoal goal,
        Phase phase,
        LoadLadder ladder)
    {
        ArgumentNullException.ThrowIfNull(history);
        ArgumentNullException.ThrowIfNull(goal);
        ArgumentNullException.ThrowIfNull(phase);
        ArgumentNullException.ThrowIfNull(ladder);

        var p = goal.Parameters;
        var lastSession = history.LastSession;

        if (lastSession.Count == 0) return StartingPoint(goal, ladder);

        // The heaviest set of the last session is what progression tracks.
        var top = lastSession.MaxBy(s => s.ComputedLb)!;
        var minReps = lastSession.Min(s => s.Reps);

        // Rehab never chases load; the metric is consistency.
        if (!p.ProgressesLoad)
        {
            return Repeat(top, p, ProgressionLever.Hold,
                "Same as last time. For rehab, showing up consistently is the progress.");
        }

        // What the same configuration would give TODAY. Diverges from what was logged when
        // bodyweight has moved, which is the whole reason this engine exists.
        var loadNow = ladder.Rungs
            .FirstOrDefault(r => r.Level == top.Level
                                 && Math.Abs(r.VestLb - top.VestLb) < 0.01
                                 && Math.Abs(r.BarLb - top.BarLb) < 0.01)
            ?.ComputedLb ?? top.ComputedLb;

        var drift = loadNow - top.ComputedLb;

        // --- Deficit: hold absolute load. Maintaining it while losing weight IS the progress,
        // and it is what preserves lean mass. ---
        if (phase.Balance == EnergyBalance.Deficit)
        {
            if (drift < -TargetToleranceLb)
            {
                var restored = Reach(top.ComputedLb, ladder, top.Level, preferLevel: true);
                if (restored is not null)
                {
                    return new Recommendation(
                        restored.Level, restored.VestLb, restored.BarLb, restored.ComputedLb,
                        top.Reps, DefaultSets, ProgressionLever.CompensateBodyweight,
                        $"You're lighter than last time, so level {top.Level} now gives "
                        + $"{loadNow:0.#} lb instead of {top.ComputedLb:0.#}. This keeps your "
                        + "load where it was — that's how you hold onto muscle while losing fat.");
                }
            }

            return Repeat(top, p, ProgressionLever.Hold,
                $"Holding at {top.ComputedLb:0.#} lb. While you're losing weight, keeping your "
                + "lifts steady is the win — don't chase a PR right now.");
        }

        // --- Reps before load. Only step the load once the top of the range is earned. ---
        if (minReps < p.MaxReps)
        {
            return Repeat(top, p, ProgressionLever.AddReps,
                $"Same {top.ComputedLb:0.#} lb, aim for {Math.Min(minReps + 1, p.MaxReps)} reps. "
                + $"Once you hit {p.MaxReps} on every set, we'll add load.");
        }

        var target = top.ComputedLb * (1 + p.LoadStepFraction);
        var next = Reach(target, ladder, top.Level, preferLevel: true);

        if (next is null)
        {
            return Repeat(top, p, ProgressionLever.Hold,
                $"You're at the top of what this setup can give ({top.ComputedLb:0.#} lb). "
                + "Add a vest or plates to keep progressing.");
        }

        var lever = next.Level > top.Level ? ProgressionLever.IncreaseLevel
                  : next.AddedLb > top.VestLb + top.BarLb ? ProgressionLever.AddWeight
                  : ProgressionLever.AddReps;

        var rationale = lever switch
        {
            ProgressionLever.IncreaseLevel =>
                $"You hit {p.MaxReps} reps at {top.ComputedLb:0.#} lb. Move to level "
                + $"{next.Level} for {next.ComputedLb:0.#} lb and drop back to {p.MinReps} reps.",
            ProgressionLever.AddWeight when top.Level >= ladder.Profile.LevelCount =>
                $"You're at the highest level, so add {next.AddedLb - top.VestLb - top.BarLb:0.#} lb "
                + $"to reach {next.ComputedLb:0.#} lb.",
            ProgressionLever.AddWeight =>
                $"A whole level would jump too far from here. Add "
                + $"{next.AddedLb - top.VestLb - top.BarLb:0.#} lb instead for a smaller step to "
                + $"{next.ComputedLb:0.#} lb.",
            _ => $"Aim for {p.MaxReps} reps at {next.ComputedLb:0.#} lb."
        };

        return new Recommendation(
            next.Level, next.VestLb, next.BarLb, next.ComputedLb,
            lever == ProgressionLever.AddReps ? Math.Min(minReps + 1, p.MaxReps) : p.MinReps,
            DefaultSets, lever, rationale);
    }

    /// <summary>
    /// Finds a rung at or above <paramref name="targetLb"/>, choosing the lever by step size.
    /// A level increase wins when it lands close to target AND is not too coarse a jump;
    /// otherwise added weight bridges the gap.
    /// </summary>
    private static LoadRung? Reach(double targetLb, LoadLadder ladder, int currentLevel, bool preferLevel)
    {
        if (preferLevel && currentLevel < ladder.Profile.LevelCount)
        {
            var stepFraction = ladder.StepFractionAbove(currentLevel);
            var levelUp = ladder.Rungs.FirstOrDefault(
                r => r.Level == currentLevel + 1 && r.AddedLb == 0);

            var jumpIsReasonable = stepFraction is not null && stepFraction <= MaxLevelStepFraction;
            var landsNearTarget = levelUp is not null
                                  && levelUp.ComputedLb >= targetLb - TargetToleranceLb;

            if (jumpIsReasonable && landsNearTarget) return levelUp;
        }

        // Otherwise: smallest achievable rung at or above target, staying at or above the
        // current level so the coach never quietly walks the trainee backwards.
        return ladder.SmallestAtLeast(targetLb, r => r.Level >= currentLevel)
               ?? ladder.SmallestAtLeast(targetLb);
    }

    private static Recommendation Repeat(
        SetRecord top, GoalParameters p, ProgressionLever lever, string rationale) =>
        new(top.Level, top.VestLb, top.BarLb, top.ComputedLb,
            Math.Min(top.Reps + (lever == ProgressionLever.AddReps ? 1 : 0), p.MaxReps),
            DefaultSets, lever, rationale);

    private static Recommendation StartingPoint(TrainingGoal goal, LoadLadder ladder)
    {
        var p = goal.Parameters;

        // Start where a level step is a manageable percentage, so there is somewhere to go in
        // both directions. On a 14-notch rail that lands around level 5.
        var level = Enumerable.Range(1, ladder.Profile.LevelCount)
            .FirstOrDefault(l => ladder.StepFractionAbove(l) <= MaxLevelStepFraction);
        if (level == 0) level = 1;

        var lb = ladder.BareLoad(level);

        return new Recommendation(
            level, 0, 0, lb, p.MinReps, DefaultSets, ProgressionLever.StartingPoint,
            $"Start at level {level} — about {lb:0.#} lb for you. Aim for {p.MinReps}–{p.MaxReps} "
            + "reps and we'll tune it from there.");
    }
}
