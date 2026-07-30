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
