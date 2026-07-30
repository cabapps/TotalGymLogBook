namespace TotalGymLogBook.Domain.Training;

public enum EquipmentKind
{
    /// <summary>Worn, so it rides the incline with the body and tracks bodyFraction.</summary>
    VestBlock,

    /// <summary>Bolted to the glideboard, so always fully loaded regardless of bodyFraction.</summary>
    BarPlate
}

public sealed record EquipmentItem(EquipmentKind Kind, double Lb, int Quantity);

/// <summary>What the user actually owns. The coach must only ever suggest increments the
/// trainee can physically make.</summary>
public sealed record EquipmentInventory(IReadOnlyList<EquipmentItem> Items)
{
    public static readonly EquipmentInventory None = new([]);

    public IEnumerable<EquipmentItem> Of(EquipmentKind kind) => Items.Where(i => i.Kind == kind);
}

/// <summary>One achievable configuration and the load it produces.</summary>
public sealed record LoadRung(int Level, double VestLb, double BarLb, double ComputedLb)
{
    public double AddedLb => VestLb + BarLb;
}

/// <summary>
/// Every load the trainee can actually reach, given their machine, bodyweight, the exercise,
/// and the equipment they own.
///
/// This exists because progression on a Total Gym has more than one lever, and they interact:
/// level steps are near-uniform in pounds but wildly non-uniform in percentage (21% at the
/// bottom of a 14-notch rail, 6% at the top), and added weight is heavily discounted by the
/// incline. Reducing everything to one comparable figure is what makes "level 7 plus a 20 lb
/// vest" and "level 8" commensurable. See docs/adr/0004.
/// </summary>
public sealed class LoadLadder
{
    /// <summary>Achievable added weights are quantised to this, matching real plate steps.</summary>
    private const double ResolutionLb = 0.5;

    private const double MaxAddedLb = 200;

    public RailProfile Profile { get; }
    public double BodyweightLb { get; }
    public bool UsesPulley { get; }
    public double BodyFraction { get; }
    public IReadOnlyList<LoadRung> Rungs { get; }

    public LoadLadder(
        RailProfile profile,
        double bodyweightLb,
        EquipmentInventory inventory,
        bool usesPulley = false,
        double bodyFraction = 1.0)
    {
        ArgumentNullException.ThrowIfNull(profile);
        ArgumentNullException.ThrowIfNull(inventory);

        Profile = profile;
        BodyweightLb = bodyweightLb;
        UsesPulley = usesPulley;
        BodyFraction = bodyFraction;

        var vestOptions = AchievableSums(inventory.Of(EquipmentKind.VestBlock));
        var barOptions = AchievableSums(inventory.Of(EquipmentKind.BarPlate));

        var rungs = new List<LoadRung>();
        for (var level = 1; level <= profile.LevelCount; level++)
        foreach (var vest in vestOptions)
        foreach (var bar in barOptions)
        {
            var lb = ResistanceCalculator.Compute(profile, new ResistanceInputs
            {
                BodyweightLb = bodyweightLb,
                Level = level,
                UsesPulley = usesPulley,
                BodyFraction = bodyFraction,
                VestLb = vest,
                BarLb = bar
            });

            rungs.Add(new LoadRung(level, vest, bar, Math.Round(lb, 1)));
        }

        Rungs = rungs.OrderBy(r => r.ComputedLb).ThenBy(r => r.AddedLb).ToList();
    }

    /// <summary>Load at a level with nothing added. The baseline the coach compares against.</summary>
    public double BareLoad(int level) => Math.Round(
        ResistanceCalculator.Compute(Profile, new ResistanceInputs
        {
            BodyweightLb = BodyweightLb,
            Level = level,
            UsesPulley = UsesPulley,
            BodyFraction = BodyFraction
        }), 1);

    /// <summary>
    /// Fractional jump from <paramref name="level"/> to the next. The coach uses this rather
    /// than hardcoded level numbers, so the "steps are too coarse down here" rule derives from
    /// the physics and holds on any rail profile.
    /// </summary>
    public double? StepFractionAbove(int level)
    {
        if (level >= Profile.LevelCount) return null;

        var here = BareLoad(level);
        return here <= 0 ? null : (BareLoad(level + 1) - here) / here;
    }

    /// <summary>Cheapest rung at or above <paramref name="targetLb"/>, optionally constrained.</summary>
    public LoadRung? SmallestAtLeast(double targetLb, Func<LoadRung, bool>? where = null) =>
        Rungs.FirstOrDefault(r => r.ComputedLb >= targetLb - 0.05 && (where?.Invoke(r) ?? true));

    /// <summary>Rung closest to <paramref name="targetLb"/> in either direction.</summary>
    public LoadRung? Nearest(double targetLb, Func<LoadRung, bool>? where = null) =>
        Rungs.Where(r => where?.Invoke(r) ?? true)
             .OrderBy(r => Math.Abs(r.ComputedLb - targetLb))
             .ThenBy(r => r.AddedLb)
             .FirstOrDefault();

    /// <summary>
    /// Distinct totals reachable from a pile of weights, via bounded subset-sum on a 0.5 lb
    /// grid. Always includes zero.
    /// </summary>
    private static IReadOnlyList<double> AchievableSums(IEnumerable<EquipmentItem> items)
    {
        var slots = (int)(MaxAddedLb / ResolutionLb) + 1;
        var reachable = new bool[slots];
        reachable[0] = true;

        foreach (var item in items)
        {
            var step = (int)Math.Round(item.Lb / ResolutionLb);
            if (step <= 0) continue;

            for (var n = 0; n < item.Quantity; n++)
            {
                // Descending so each physical weight is consumed at most once per iteration.
                for (var i = slots - 1 - step; i >= 0; i--)
                {
                    if (reachable[i]) reachable[i + step] = true;
                }
            }
        }

        return Enumerable.Range(0, slots)
            .Where(i => reachable[i])
            .Select(i => i * ResolutionLb)
            .ToList();
    }
}
