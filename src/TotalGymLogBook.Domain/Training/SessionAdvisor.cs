namespace TotalGymLogBook.Domain.Training;

/// <summary>
/// One muscle that is short of work this week, and the movements that would fix it.
/// </summary>
public sealed record MuscleGap(
    MuscleGroup Muscle,
    double WeeklySets,
    double MinimumSets,
    int? DaysSinceTrained,
    IReadOnlyList<Exercise> Fixes)
{
    /// <summary>Direct sets still needed. Whole sets, because you cannot do 1.4 of one.</summary>
    public int ShortfallSets => (int)Math.Ceiling(Math.Max(0, MinimumSets - WeeklySets));
}

public sealed record SessionAdvice(string Headline, IReadOnlyList<MuscleGap> Gaps)
{
    public static readonly SessionAdvice Silent = new("", []);

    public bool HasGaps => Gaps.Count > 0;
}

/// <summary>
/// Session-level coaching: what is MISSING this week, as opposed to
/// <see cref="ProgressionEngine"/>, which answers what to do on the set in front of you.
///
/// The unit is sets per muscle per week, which is the unit the hypertrophy dose-response
/// literature actually uses — not sessions, not hours, not tonnage. A week is the conventional
/// accounting period because that is the shortest span over which a training plan repeats.
///
/// Two things this deliberately does not do:
///
///   It never nags about a muscle that has NEVER been trained. Skipping calves entirely is a
///   programme choice, not a gap, and an app that cannot tell the difference reads as broken.
///   <see cref="VolumeLedger.BelowEffectiveDose"/> already draws that line; this respects it.
///
///   It never says "you are doing too much". There is no upper bound in
///   <see cref="VolumeTarget"/>, and this has no view of sleep, stress, or joints, so it is in
///   no position to (docs/adr/0010).
/// </summary>
public sealed class SessionAdvisor
{
    /// <summary>More than a few gaps at once is a wall of text nobody acts on.</summary>
    public const int MaxGaps = 3;

    /// <summary>Two suggestions per gap: one obvious, one alternative.</summary>
    public const int FixesPerGap = 2;

    /// <summary>
    /// Only draw the "quads are fine, biceps are not" contrast when the two are genuinely far
    /// apart. Comparing 4.5 sets against 4.0 invites the trainee to fix something that is not
    /// broken.
    /// </summary>
    public const double ContrastSets = 4.0;

    public SessionAdvice Advise(
        IReadOnlyList<MuscleVolume> summary,
        ExerciseCatalog catalog,
        VolumeTarget target,
        IReadOnlyCollection<string>? ownedAttachments = null,
        IReadOnlyCollection<string>? familiarExerciseIds = null)
    {
        ArgumentNullException.ThrowIfNull(summary);
        ArgumentNullException.ThrowIfNull(catalog);
        ArgumentNullException.ThrowIfNull(target);

        // A muscle with no history at all is not a gap -- see the class remarks.
        var trained = summary.Where(v => v.DaysSinceTrained is not null).ToList();
        if (trained.Count == 0) return SessionAdvice.Silent;

        var available = catalog.Available(ownedAttachments);
        var familiar = familiarExerciseIds is null
            ? new HashSet<string>(StringComparer.Ordinal)
            : new HashSet<string>(familiarExerciseIds, StringComparer.Ordinal);

        var gaps = trained
            .Where(v => v.BelowMinimum(target))
            .OrderBy(v => v.WeeklySets)
            .ThenByDescending(v => v.DaysSinceTrained ?? 0)
            .Take(MaxGaps)
            .Select(v => new MuscleGap(
                v.Muscle,
                v.WeeklySets,
                target.MinimumEffectiveSets,
                v.DaysSinceTrained,
                FixesFor(v.Muscle, available, familiar)))
            .ToList();

        var best = trained.MaxBy(v => v.WeeklySets)!;

        return new SessionAdvice(Capitalise(Headline(gaps, best, target)), gaps);
    }

    /// <summary>
    /// Movements where the gap muscle is the prime mover. Indirect work is excluded on purpose:
    /// filling a biceps gap with more rows is how the gap got there.
    ///
    /// Familiar movements come first. Someone mid-workout wants the exercise they already know
    /// the setup for, not an introduction to a new one.
    /// </summary>
    private static IReadOnlyList<Exercise> FixesFor(
        MuscleGroup muscle,
        IReadOnlyList<Exercise> available,
        IReadOnlySet<string> familiar) =>
        available
            .Where(e => e.CountsAsVolume && e.InvolvementOf(muscle) >= MuscleInvolvement.Direct)
            .OrderByDescending(e => familiar.Contains(e.Id))
            .Take(FixesPerGap)
            .ToList();

    /// <summary>Muscle labels are lowercase by design, and half of them start a sentence.</summary>
    private static string Capitalise(string text) =>
        text.Length == 0 ? text : char.ToUpperInvariant(text[0]) + text[1..];

    private static string Headline(
        IReadOnlyList<MuscleGap> gaps, MuscleVolume best, VolumeTarget target)
    {
        if (gaps.Count == 0)
        {
            return $"Everything you've trained this week is at {target.MinimumEffectiveSets:0} "
                   + "sets or more, which is where growth starts. Nothing to patch up.";
        }

        var worst = gaps[0];
        var fix = worst.Fixes.FirstOrDefault();
        var sets = Math.Max(1, worst.ShortfallSets);

        var suggestion = fix is null
            ? $"{worst.Muscle.Label()} could use another {MuscleGroups.Sets(sets)} this week."
            : $"{MuscleGroups.Sets(sets)} of {fix.Name} would get {worst.Muscle.Label()} there.";

        // The comparison the trainee actually feels: one thing well covered, another not.
        if (best.Muscle != worst.Muscle && best.WeeklySets - worst.WeeklySets >= ContrastSets)
        {
            return $"You've put {MuscleGroups.Sets(best.WeeklySets)} into {best.Muscle.Label()} "
                   + $"this week and {worst.WeeklySets:0.#} into {worst.Muscle.Label()}. {suggestion}";
        }

        return $"{worst.Muscle.Label()} {worst.Muscle.IsAre()} at "
               + $"{MuscleGroups.Sets(worst.WeeklySets)} this week, under the "
               + $"{target.MinimumEffectiveSets:0} where growth starts. {suggestion}";
    }
}
