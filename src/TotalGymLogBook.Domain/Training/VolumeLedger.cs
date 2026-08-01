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

public sealed record MuscleVolume(MuscleGroup Muscle, double WeeklySets, int? DaysSinceTrained)
{
    public bool BelowMinimum(VolumeTarget target) => WeeklySets < target.MinimumEffectiveSets;
    public bool BelowRecommended(VolumeTarget target) => WeeklySets < target.RecommendedSets;
}

/// <summary>
/// Read-only rollup of weekly sets per muscle, with indirect work counted at its fractional
/// rate.
///
/// This is a MONITORING concern, not a progression one. Changing set count is a programme
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
        DateOnly asOf, int windowDays = DefaultWindowDays)
    {
        var from = asOf.AddDays(-windowDays);
        var totals = new Dictionary<MuscleGroup, double>();

        foreach (var history in _histories)
        {
            if (!_catalog.TryGetValue(history.ExerciseId, out var exercise)) continue;

            // A stretch is not a hard set. Counting the stretch catalogue as volume would tell
            // a trainee their hamstrings are covered because they stretched them.
            if (!exercise.CountsAsVolume) continue;

            var sets = history.Sets.Count(s => s.On > from && s.On <= asOf);
            if (sets == 0) continue;

            foreach (var involvement in exercise.Muscles)
            {
                totals[involvement.Muscle] =
                    totals.GetValueOrDefault(involvement.Muscle) + sets * involvement.Fraction;
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
        var weekly = WeeklySets(asOf, windowDays);

        return Enum.GetValues<MuscleGroup>()
            .Select(m => new MuscleVolume(m, weekly.GetValueOrDefault(m), DaysSinceTrained(m, asOf)))
            .OrderBy(v => v.WeeklySets)
            .ToList();
    }

    /// <summary>
    /// Muscles that have seen work but are under the effective dose. Deliberately excludes
    /// muscles never trained at all — a user who does not train calves does not need nagging
    /// about calves; that is a programme choice, not a gap.
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
