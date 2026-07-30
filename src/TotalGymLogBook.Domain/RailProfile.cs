namespace TotalGymLogBook.Domain;

/// <summary>Where a profile's incline angles came from. See docs/adr/0004.</summary>
public enum AngleSource
{
    /// <summary>Printed in Total Gym's published resistance chart.</summary>
    Published,

    /// <summary>Back-solved from a chart's resistance columns because the printed angles are wrong.</summary>
    Derived,

    /// <summary>Measured on a specific machine with the phone inclinometer.</summary>
    Calibrated
}

/// <summary>
/// The geometry of one rail. Profiles key on level count rather than model name, because
/// Total Gym publishes resistance charts by level count and several models share a rail.
/// </summary>
public sealed record RailProfile
{
    public required string Id { get; init; }
    public required IReadOnlyList<double> AngleDeg { get; init; }

    /// <summary>
    /// Effective mass of the glideboard assembly riding the incline. Derived, not published:
    /// regressing a chart row against bodyweight yields slope == sin(angle) plus a constant
    /// intercept, and intercept / sin(angle) is stable across every level of a profile.
    /// Accurate to about +/- 1 lb because the charts round to whole pounds.
    /// </summary>
    public required double BoardWeightLb { get; init; }

    public AngleSource AngleSource { get; init; } = AngleSource.Published;

    /// <summary>False when the angles have not been confirmed against a physical machine.</summary>
    public bool Verified { get; init; } = true;

    public int LevelCount => AngleDeg.Count;

    /// <summary>Incline angle at <paramref name="level"/>, which is 1-based.</summary>
    public double AngleForLevel(int level)
    {
        if (level < 1 || level > LevelCount)
        {
            throw new ArgumentOutOfRangeException(
                nameof(level), level, $"Profile '{Id}' has levels 1-{LevelCount}.");
        }

        return AngleDeg[level - 1];
    }
}
