namespace TotalGymLogBook.Domain.Training;

public enum MuscleGroup
{
    Chest,
    Back,
    Shoulders,
    Biceps,
    Triceps,
    Quadriceps,
    Hamstrings,
    Adductors,
    Glutes,
    Calves,
    Core
}

/// <summary>
/// Shared vocabulary for anything the coach says out loud. One place, because the alternative
/// is "quads" on one screen and "quadriceps" on the next, and "shoulders is at 1 sets" on both.
/// </summary>
public static class MuscleGroups
{
    /// <summary>What a trainee calls it. Anatomy-lecture names help nobody mid-set.</summary>
    public static string Label(this MuscleGroup muscle) => muscle switch
    {
        MuscleGroup.Quadriceps => "quads",
        MuscleGroup.Adductors => "inner thighs",
        _ => muscle.ToString().ToLowerInvariant()
    };

    /// <summary>
    /// "is" or "are" for this muscle's label. Most of them are plural -- shoulders, quads,
    /// glutes, calves -- and lifters say "biceps are", not "biceps is".
    /// </summary>
    public static string IsAre(this MuscleGroup muscle) => muscle switch
    {
        MuscleGroup.Chest or MuscleGroup.Back or MuscleGroup.Core => "is",
        _ => "are"
    };

    /// <summary>
    /// A set count that reads like English. Fractional counts are normal here -- indirect work
    /// counts as half a set -- so 1 is "1 set" while 1.5 is "1.5 sets".
    /// </summary>
    public static string Sets(double count) =>
        $"{count:0.#} set{(Math.Abs(count - 1) < 0.001 ? "" : "s")}";

    /// <summary>
    /// Roughly how much trainable muscle this group is, relative to the largest, on a 0–1 scale.
    ///
    /// Used only for RANKING exercises, never for computing a load or a set count. It is what
    /// lets a program aimed at fat loss lead with the movements that build the most tissue per
    /// session: more muscle is more resting metabolism, and in a deficit the training's job is
    /// to keep and add lean mass rather than to burn calories during the set (docs/adr/0010).
    ///
    /// Approximate on purpose. The ordering between quads and calves is not controversial and is
    /// all this needs to get right; the exact numbers are not claimed to be measurements.
    /// </summary>
    public static double RelativeMass(this MuscleGroup muscle) => muscle switch
    {
        MuscleGroup.Quadriceps => 1.00,
        MuscleGroup.Back => 0.90,
        MuscleGroup.Glutes => 0.80,
        MuscleGroup.Hamstrings => 0.60,
        MuscleGroup.Chest => 0.55,
        MuscleGroup.Shoulders => 0.40,
        MuscleGroup.Adductors => 0.30,
        MuscleGroup.Calves => 0.30,
        MuscleGroup.Triceps => 0.30,
        MuscleGroup.Core => 0.25,
        MuscleGroup.Biceps => 0.20,
        _ => 0.25
    };
}

/// <summary>
/// How much one set of an exercise counts toward a muscle's weekly volume.
///
/// Fractional accounting matters more on a Total Gym than on isolation machines, because
/// almost everything is compound. A chest press is a full set for the chest but only a partial
/// one for triceps and front delts. Counting it as a whole set everywhere inflates arm volume
/// that is already being covered; counting it as nothing hides real work.
/// </summary>
public sealed record MuscleInvolvement(MuscleGroup Muscle, double Fraction)
{
    /// <summary>Prime mover. One logged set counts as one set.</summary>
    public const double Direct = 1.0;

    /// <summary>Meaningful secondary involvement. Counts as half a set.</summary>
    public const double Indirect = 0.5;

    public static MuscleInvolvement Primary(MuscleGroup m) => new(m, Direct);
    public static MuscleInvolvement Secondary(MuscleGroup m) => new(m, Indirect);
}

/// <summary>
/// One movement. <see cref="UsesPulley"/> and <see cref="BodyFraction"/> feed the resistance
/// calculation (docs/adr/0004); <see cref="Muscles"/> feeds the volume ledger.
/// </summary>
/// <summary>
/// Whether a logged set of this movement is TRAINING VOLUME.
///
/// Without the distinction, adding the stretch catalog would silently inflate every muscle's
/// weekly set count and make the coach's volume advice wrong -- a stretch is not a hard set.
/// </summary>
public enum ExerciseKind
{
    Strength,
    Stretch
}

/// <summary>
/// Where in a movement's range the muscle is most loaded.
///
/// Loaded work at long muscle lengths grows a muscle more than the same sets through a shortened
/// range, and this machine is unusually good at it: a cable holds tension at the bottom of a fly
/// where a dumbbell goes slack. A hypertrophy program built here should lean on the lengthened
/// ones — see docs/adr/0010.
///
/// A judgment about mechanics, in the same class as BodyFraction: informed, reviewable, and not
/// measured. Getting one wrong changes which exercise the builder suggests first, never a
/// recorded number.
/// </summary>
public enum PeakTension
{
    Lengthened,
    Even,
    Shortened
}

public sealed record Exercise
{
    public required string Id { get; init; }
    public required string Name { get; init; }

    /// <summary>Grouping for the exercise picker. Presentation only.</summary>
    public string Category { get; init; } = "";

    public ExerciseKind Kind { get; init; } = ExerciseKind.Strength;

    /// <summary>True when a set of this counts toward weekly volume.</summary>
    public bool CountsAsVolume => Kind == ExerciseKind.Strength;

    /// <summary>True when the movement routes through the cable, which halves the load.</summary>
    public bool UsesPulley { get; init; }

    /// <summary>Where in the range the muscle is most loaded. See <see cref="PeakTension"/>.</summary>
    public PeakTension PeakTension { get; init; } = PeakTension.Even;

    /// <summary>
    /// True when the load is highest with the muscle long — the movements a hypertrophy program
    /// should be built around on this machine.
    /// </summary>
    public bool IsLengthenedLoaded => PeakTension == PeakTension.Lengthened;

    /// <summary>Fraction of the body actually riding the glideboard.</summary>
    public double BodyFraction { get; init; } = 1.0;

    public required IReadOnlyList<MuscleInvolvement> Muscles { get; init; }

    /// <summary>Accessory required, if any. Used to filter the catalog to what the user owns.</summary>
    public string? Attachment { get; init; }

    public double InvolvementOf(MuscleGroup muscle) =>
        Muscles.FirstOrDefault(m => m.Muscle == muscle)?.Fraction ?? 0;
}
