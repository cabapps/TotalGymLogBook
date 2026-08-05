namespace TotalGymLogBook.Domain.Training;

/// <summary>
/// Training age. Inferred from history rather than asked, the same way phase is: someone with
/// three weeks of logs is a novice whatever they claim. Available as an advanced override.
/// </summary>
public enum ExperienceLevel
{
    Novice,
    Intermediate,
    Advanced
}

/// <summary>
/// Weekly set targets for one muscle group.
///
/// There is deliberately NO upper bound. The dose-response for hypertrophy keeps climbing well
/// past any figure this app could justify enforcing, and it has no way to observe recovery —
/// sleep, stress, joint health — so it is in no position to tell anyone they are doing too
/// much. Under-training is also overwhelmingly the failure mode in a home-gym population.
/// The ledger reports; the trainee decides.
/// </summary>
public sealed record VolumeTarget(double MinimumEffectiveSets, double RecommendedSets)
{
    /// <summary>
    /// Minimum effective dose for hypertrophy, in sets per muscle per week. Meta-analysis puts
    /// meaningful growth below five sets weekly, so this is a genuine floor rather than a
    /// conservative guess — and it is reachable for someone training a couple of times a week.
    /// </summary>
    public const double MinimumEffectiveDose = 4.0;

    public static VolumeTarget For(ExperienceLevel experience, EnergyBalance balance = EnergyBalance.Unknown)
    {
        var recommended = experience switch
        {
            ExperienceLevel.Novice => 8.0,
            ExperienceLevel.Intermediate => 14.0,
            ExperienceLevel.Advanced => 20.0,
            _ => 8.0
        };

        // A deficit does not cap volume; it just stops recommending increases. Recovery
        // capacity is reduced, so holding steady is the sensible default. See docs/adr/0010.
        if (balance == EnergyBalance.Deficit)
        {
            recommended = Math.Max(MinimumEffectiveDose, recommended * 0.8);
        }

        return new VolumeTarget(MinimumEffectiveDose, recommended);
    }
}

/// <summary>
/// What each side got, for muscles that have limbs.
///
/// The two sides drift, and the only way anyone sees it is to count them apart. A trainee who
/// always starts on the right and runs out of time has been building an imbalance for months,
/// and a pooled total says nothing about it at all.
/// </summary>
public sealed record SideVolume(double Left, double Right)
{
    public static readonly SideVolume None = new(0, 0);

    /// <summary>The headline: what each side got, on average. A bilateral set feeds both.</summary>
    public double Average => (Left + Right) / 2;

    /// <summary>True once one side is a full set ahead -- below that it is just rounding.</summary>
    public bool Lopsided => Math.Abs(Left - Right) >= 1;

    public SideVolume Plus(BodySide? side, double sets) => side switch
    {
        BodySide.Left => this with { Left = Left + sets },
        BodySide.Right => this with { Right = Right + sets },
        // A set with no side is either a two-limb movement, which trained both, or a one-limb set
        // logged before the app asked. Both are honestly served by adding it to each: the first
        // because it is true, the second because half a set each preserves the total without
        // inventing which leg it was.
        _ => new SideVolume(Left + sets, Right + sets),
    };
}

public sealed record MuscleVolume(
    MuscleGroup Muscle, double WeeklySets, int? DaysSinceTrained)
{
    /// <summary>How the week split across the two sides. Equal for anyone training bilaterally.</summary>
    public SideVolume Sides { get; init; } = SideVolume.None;

    public bool BelowMinimum(VolumeTarget target) => WeeklySets < target.MinimumEffectiveSets;
    public bool BelowRecommended(VolumeTarget target) => WeeklySets < target.RecommendedSets;
}

/// <summary>
/// Read-only rollup of weekly sets per muscle, with indirect work counted at its fractional
/// rate.
///
/// This is a MONITORING concern, not a progression one. Changing set count is a program
/// change — driven by experience and goals — whereas reps and load move session to session.
/// <see cref="ProgressionEngine"/> deliberately does not touch it.
/// </summary>
public sealed class VolumeLedger
{
    public const int DefaultWindowDays = 7;

    private readonly IReadOnlyList<ExerciseHistory> _histories;
    private readonly IReadOnlyDictionary<string, Exercise> _catalog;

    public VolumeLedger(
        IEnumerable<ExerciseHistory> histories,
        IReadOnlyDictionary<string, Exercise> catalog)
    {
        ArgumentNullException.ThrowIfNull(histories);
        ArgumentNullException.ThrowIfNull(catalog);

        _histories = histories.ToList();
        _catalog = catalog;
    }

    /// <summary>Sets per muscle over the trailing window, indirect work counted fractionally.</summary>
    public IReadOnlyDictionary<MuscleGroup, double> WeeklySets(
        DateOnly asOf, int windowDays = DefaultWindowDays) =>
        WeeklySides(asOf, windowDays).ToDictionary(kv => kv.Key, kv => kv.Value.Average);

    /// <summary>
    /// The same rollup, kept apart by side.
    ///
    /// This is the primitive and WeeklySets is the summary of it, because the two must not be
    /// able to disagree. A bilateral set counts once to each side, a unilateral set counts to the
    /// side it was logged against, and the headline is the average -- which is what makes three
    /// sets per leg read as three, the figure comparable to three sets of a two-legged squat.
    /// </summary>
    public IReadOnlyDictionary<MuscleGroup, SideVolume> WeeklySides(
        DateOnly asOf, int windowDays = DefaultWindowDays)
    {
        var from = asOf.AddDays(-windowDays);
        var totals = new Dictionary<MuscleGroup, SideVolume>();

        foreach (var history in _histories)
        {
            if (!_catalog.TryGetValue(history.ExerciseId, out var exercise)) continue;

            // A stretch is not a hard set. Counting the stretch catalog as volume would tell
            // a trainee their hamstrings are covered because they stretched them.
            if (!exercise.CountsAsVolume) continue;

            foreach (var set in history.Sets.Where(s => s.On > from && s.On <= asOf))
            {
                // A unilateral set with no recorded side is half to each: it trained one limb and
                // nobody wrote down which, so splitting it keeps the total honest without
                // inventing a lopsided week that never happened.
                var side = exercise.Unilateral ? set.Side : null;
                var each = exercise.Unilateral && side is null ? 0.5 : 1.0;

                foreach (var involvement in exercise.Muscles)
                {
                    var current = totals.GetValueOrDefault(involvement.Muscle, SideVolume.None);
                    totals[involvement.Muscle] = current.Plus(side, involvement.Fraction * each);
                }
            }
        }

        return totals;
    }

    /// <summary>Days since a muscle was last trained at all, or null if never.</summary>
    public int? DaysSinceTrained(MuscleGroup muscle, DateOnly asOf)
    {
        DateOnly? last = null;

        foreach (var history in _histories)
        {
            if (!_catalog.TryGetValue(history.ExerciseId, out var exercise)) continue;
            if (!exercise.CountsAsVolume || exercise.InvolvementOf(muscle) <= 0) continue;

            foreach (var set in history.Sets.Where(s => s.On <= asOf))
            {
                if (last is null || set.On > last) last = set.On;
            }
        }

        return last is null ? null : asOf.DayNumber - last.Value.DayNumber;
    }

    /// <summary>Full picture across every muscle group, ordered by neglect.</summary>
    public IReadOnlyList<MuscleVolume> Summary(DateOnly asOf, int windowDays = DefaultWindowDays)
    {
        var weekly = WeeklySides(asOf, windowDays);

        return Enum.GetValues<MuscleGroup>()
            .Select(m =>
            {
                var sides = weekly.GetValueOrDefault(m, SideVolume.None);
                return new MuscleVolume(m, sides.Average, DaysSinceTrained(m, asOf))
                {
                    Sides = sides,
                };
            })
            .OrderBy(v => v.WeeklySets)
            .ToList();
    }

    /// <summary>
    /// Muscles that have seen work but are under the effective dose. Deliberately excludes
    /// muscles never trained at all — a user who does not train calves does not need nagging
    /// about calves; that is a program choice, not a gap.
    /// </summary>
    public IReadOnlyList<MuscleVolume> BelowEffectiveDose(
        DateOnly asOf, VolumeTarget target, int windowDays = DefaultWindowDays) =>
        Summary(asOf, windowDays)
            .Where(v => v.DaysSinceTrained is not null && v.BelowMinimum(target))
            .ToList();

    /// <summary>
    /// Plain-language nudges. Reports gaps and neglect; never warns about doing too much.
    /// </summary>
    public IReadOnlyList<string> Nudges(DateOnly asOf, VolumeTarget target, int staleDays = 10)
    {
        var notes = new List<string>();

        foreach (var v in Summary(asOf))
        {
            if (v.DaysSinceTrained is null) continue;

            if (v.DaysSinceTrained >= staleDays)
            {
                notes.Add($"You haven't worked {v.Muscle.Label()} in {v.DaysSinceTrained} days.");
            }
            else if (v.BelowMinimum(target))
            {
                notes.Add(
                    $"{v.Muscle.Label()} {v.Muscle.IsAre()} at {MuscleGroups.Sets(v.WeeklySets)} "
                    + $"this week. About {target.MinimumEffectiveSets:0} is where growth starts.");
            }
        }

        return notes;
    }

}
