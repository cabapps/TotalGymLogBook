namespace TotalGymLogBook.Domain;

/// <summary>Everything that goes into one resistance figure. See docs/adr/0004.</summary>
public readonly record struct ResistanceInputs
{
    public required double BodyweightLb { get; init; }

    /// <summary>1-based rail notch.</summary>
    public required int Level { get; init; }

    /// <summary>True for cable exercises, which halve the load.</summary>
    public bool UsesPulley { get; init; }

    /// <summary>
    /// Fraction of the body actually on the glideboard. Supine pressing is ~1.0; seated or
    /// kneeling work is less. A vest tracks this because it is strapped to the body.
    /// </summary>
    public double BodyFraction { get; init; } = 1.0;

    /// <summary>Weighted vest. Rides the incline with the body, so it tracks BodyFraction.</summary>
    public double VestLb { get; init; }

    /// <summary>Weight bar plates. Bolted to the glideboard, so always fully loaded.</summary>
    public double BarLb { get; init; }

    /// <summary>Load applied to the cable without riding the incline. Nothing in the
    /// current lineup does this; the term exists so the model need not be reshaped.</summary>
    public double DirectLoadLb { get; init; }

    public ResistanceInputs() { }
}

/// <summary>
/// Converts a rail level into actual pounds of resistance.
///
///   inclineLoad = (bodyweight + vest) * bodyFraction + bar + boardWeight
///   resistance  = inclineLoad * sin(angle) * pulleyFactor + directLoad
///
/// This is a physical model validated against Total Gym's published charts as facts, not a
/// reproduction of their tables. See docs/adr/0004 for the derivation and the copyright note.
///
/// Mirrored in client/src/resistance.ts. The two are held in step by a golden-file parity
/// test; see docs/adr/0009. Any change here must be made there too.
/// </summary>
public static class ResistanceCalculator
{
    /// <summary>Bump when the formula changes. Snapshotted onto every SetLog so historical
    /// rows can be migrated deliberately rather than drifting.</summary>
    public const int FormulaVersion = 1;

    public const double PulleyFactorCable = 0.5;
    public const double PulleyFactorDirect = 1.0;

    /// <summary>Published charts round to whole pounds, so precision beyond this is noise.</summary>
    public const int OutputDecimals = 1;

    public static double Compute(RailProfile profile, ResistanceInputs inputs)
    {
        ArgumentNullException.ThrowIfNull(profile);
        Validate(inputs);

        var angleDeg = profile.AngleForLevel(inputs.Level);
        var inclineLoad =
            (inputs.BodyweightLb + inputs.VestLb) * inputs.BodyFraction
            + inputs.BarLb
            + profile.BoardWeightLb;

        var pulleyFactor = inputs.UsesPulley ? PulleyFactorCable : PulleyFactorDirect;

        return inclineLoad * Math.Sin(double.DegreesToRadians(angleDeg)) * pulleyFactor
               + inputs.DirectLoadLb;
    }

    /// <summary>Compute, rounded to <see cref="OutputDecimals"/>. Use for display and for
    /// cross-language comparison, where two runtimes will not agree bit for bit.</summary>
    public static double ComputeRounded(RailProfile profile, ResistanceInputs inputs) =>
        Math.Round(Compute(profile, inputs), OutputDecimals, MidpointRounding.AwayFromZero);

    /// <summary>
    /// Pounds of resistance added per pound of extra mass riding the incline, at this level.
    /// Added weight is heavily discounted by the incline and users do not expect it: at 16.5
    /// degrees a 10 lb vest adds only 2.8 lb, and half that again on a cable exercise.
    /// </summary>
    public static double AddedWeightEfficiency(RailProfile profile, int level, bool usesPulley)
    {
        ArgumentNullException.ThrowIfNull(profile);

        var angleDeg = profile.AngleForLevel(level);
        return Math.Sin(double.DegreesToRadians(angleDeg))
               * (usesPulley ? PulleyFactorCable : PulleyFactorDirect);
    }

    private static void Validate(in ResistanceInputs i)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(i.BodyweightLb);
        ArgumentOutOfRangeException.ThrowIfNegative(i.VestLb);
        ArgumentOutOfRangeException.ThrowIfNegative(i.BarLb);
        ArgumentOutOfRangeException.ThrowIfNegative(i.DirectLoadLb);
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(i.BodyFraction);
        ArgumentOutOfRangeException.ThrowIfGreaterThan(i.BodyFraction, 1.0);
    }
}
