namespace TotalGymLogBook.Domain.Training;

/// <summary>
/// What a program should be BUILT out of, given what the trainee is training for.
///
/// Goals already change reps, rest and how load progresses (<see cref="GoalParameters"/>). This
/// is the other half, and it is the half that shows up in the exercise list rather than in the
/// numbers: which movements belong in the program at all.
///
/// Kept separate from <see cref="GoalType"/> because two trainees with the same goal can need
/// different programs — hypertrophy while eating enough is not hypertrophy in a deficit.
/// </summary>
public enum ProgramEmphasis
{
    /// <summary>
    /// Lead with movements loaded at long muscle lengths. Growth per set is highest there, and
    /// a cable machine holds tension in the stretch where free weights go slack.
    /// </summary>
    Lengthened,

    /// <summary>
    /// Lead with the biggest muscles. For fat loss: training does not burn a meaningful share of
    /// the deficit, so its job is to keep and add lean mass — and a pound of muscle on the quads
    /// and back does more for resting metabolism than the same effort spent on arms.
    /// </summary>
    LargestMuscles,

    /// <summary>Lead with heavy compounds — few movements, more sets, longer rest.</summary>
    HeavyCompounds,

    /// <summary>Keep the whole body moving with short rests. Density, not load.</summary>
    Circuit,

    /// <summary>Cover the body gently and evenly, with nothing that demands a hard stretch.</summary>
    Gentle
}

/// <summary>
/// What the trainee said they were training for, as they said it.
///
/// Stored alongside the derived <see cref="GoalType"/> rather than instead of it. "Lose weight"
/// and "build muscle" both produce a hypertrophy program — that is settled in docs/adr/0010 —
/// but they are not the same request, and flattening one into the other at the door means the
/// program can never act on the difference. This is the record of what was actually asked.
/// </summary>
public enum TrainingAim
{
    BuildMuscle,
    LoseFat,
    GetStronger,
    Endurance,
    Rehab
}

public static class ProgramEmphasisRules
{
    /// <summary>
    /// The stored aim, falling back to what a training style implies.
    ///
    /// The fallback is for logbooks written before the aim was recorded: they answered the same
    /// question and it was flattened to a style on the way in. Recovering it loses only the
    /// fat-loss distinction, which was never stored to begin with.
    /// </summary>
    public static TrainingAim ParseAim(string? stored, GoalType goal) => stored switch
    {
        "build-muscle" => TrainingAim.BuildMuscle,
        "lose-fat" => TrainingAim.LoseFat,
        "get-stronger" => TrainingAim.GetStronger,
        "endurance" => TrainingAim.Endurance,
        "rehab" => TrainingAim.Rehab,
        _ => goal switch
        {
            GoalType.Strength => TrainingAim.GetStronger,
            GoalType.Aerobic => TrainingAim.Endurance,
            GoalType.Rehab => TrainingAim.Rehab,
            _ => TrainingAim.BuildMuscle
        }
    };

    /// <summary>The training style a stated aim implies. See docs/adr/0010.</summary>
    public static GoalType ToGoal(this TrainingAim aim) => aim switch
    {
        TrainingAim.GetStronger => GoalType.Strength,
        TrainingAim.Endurance => GoalType.Aerobic,
        TrainingAim.Rehab => GoalType.Rehab,
        // Losing fat is not a training style. In a deficit, resistance training's job is
        // preserving and adding lean mass, and that takes mechanical tension.
        _ => GoalType.Hypertrophy
    };

    /// <summary>
    /// How to build the program.
    ///
    /// An OBSERVED deficit counts the same as a stated fat-loss aim: someone who set out to
    /// build muscle but has been losing weight for a month is, whatever they intended, training
    /// in a deficit — and the same reasoning about lean mass applies. The trend is evidence; the
    /// stated aim is intent; either one is enough.
    /// </summary>
    public static ProgramEmphasis For(
        TrainingAim aim, EnergyBalance balance = EnergyBalance.Unknown) => aim switch
    {
        TrainingAim.GetStronger => ProgramEmphasis.HeavyCompounds,
        TrainingAim.Endurance => ProgramEmphasis.Circuit,
        TrainingAim.Rehab => ProgramEmphasis.Gentle,
        TrainingAim.LoseFat => ProgramEmphasis.LargestMuscles,
        _ => balance == EnergyBalance.Deficit
            ? ProgramEmphasis.LargestMuscles
            : ProgramEmphasis.Lengthened
    };

    /// <summary>
    /// How well a movement serves this emphasis, on a 0–1 scale. Ranking only: it decides which
    /// exercise the builder offers first, never a load, a set count or anything recorded.
    /// </summary>
    public static double Score(this ProgramEmphasis emphasis, Exercise exercise)
    {
        ArgumentNullException.ThrowIfNull(exercise);

        // Total muscle the movement actually works, counting secondary involvement at its
        // fractional rate — the same accounting the volume ledger uses.
        var mass = exercise.Muscles.Sum(m => m.Muscle.RelativeMass() * m.Fraction);
        var compound = Math.Min(1.0, mass);

        return emphasis switch
        {
            ProgramEmphasis.Lengthened => exercise.PeakTension switch
            {
                PeakTension.Lengthened => 0.7 + 0.3 * compound,
                PeakTension.Even => 0.4 + 0.3 * compound,
                _ => 0.15 + 0.3 * compound
            },
            ProgramEmphasis.LargestMuscles => compound,
            ProgramEmphasis.HeavyCompounds => compound,
            ProgramEmphasis.Circuit => compound,
            // Nothing that demands a hard loaded stretch, and nothing explosive.
            ProgramEmphasis.Gentle => exercise.PeakTension == PeakTension.Lengthened ? 0.35 : 0.7,
            _ => 0.5
        };
    }

    /// <summary>One line a trainee can act on, explaining what the builder is ranking by.</summary>
    public static string Explain(this ProgramEmphasis emphasis) => emphasis switch
    {
        ProgramEmphasis.Lengthened =>
            "Movements that load the muscle stretched are listed first — that is where this "
            + "machine's constant cable tension does the most for growth.",
        ProgramEmphasis.LargestMuscles =>
            "The biggest muscles are listed first. Training barely dents the calories, so its job "
            + "while you are losing weight is to keep and add muscle — and muscle on your legs "
            + "and back does the most for what you burn at rest.",
        ProgramEmphasis.HeavyCompounds =>
            "Big compound movements first, with fewer exercises and more sets on each.",
        ProgramEmphasis.Circuit =>
            "Whole-body movements first, to keep working sets close together.",
        ProgramEmphasis.Gentle =>
            "Controlled movements first, and nothing that pulls hard into a stretch.",
        _ => ""
    };
}
