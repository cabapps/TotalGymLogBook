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
public sealed record Exercise
{
    public required string Id { get; init; }
    public required string Name { get; init; }

    /// <summary>True when the movement routes through the cable, which halves the load.</summary>
    public bool UsesPulley { get; init; }

    /// <summary>Fraction of the body actually riding the glideboard.</summary>
    public double BodyFraction { get; init; } = 1.0;

    public required IReadOnlyList<MuscleInvolvement> Muscles { get; init; }

    /// <summary>Accessory required, if any. Used to filter the catalogue to what the user owns.</summary>
    public string? Attachment { get; init; }

    public double InvolvementOf(MuscleGroup muscle) =>
        Muscles.FirstOrDefault(m => m.Muscle == muscle)?.Fraction ?? 0;
}
