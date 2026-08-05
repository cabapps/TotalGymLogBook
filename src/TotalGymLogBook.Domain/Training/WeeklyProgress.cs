namespace TotalGymLogBook.Domain.Training;

/// <summary>Which question the history chart is answering.</summary>
public enum ProgressYardstick
{
    /// <summary>Sets per muscle against the dose where growth starts.</summary>
    EffectiveDose,

    /// <summary>Sets logged against what the program plans for one rotation.</summary>
    ProgramGoal,

    /// <summary>Sets per muscle with nothing to measure them against.</summary>
    VolumeOnly
}

/// <summary>
/// One bar, always drawn as a share of ITS OWN target.
///
/// That is what lets one chart answer two different questions. Against the effective dose every
/// bar shares a target and the line reads as "four sets"; against a program each bar has its own
/// planned figure and the same line reads as "this session, done". Either way the line is at 1.0
/// and anything past it is work beyond the goal, which is the half of the question that a chart
/// scaled to the biggest bar cannot show.
/// </summary>
public sealed record ProgressBar(string Label, double Done, double Target, string Detail)
{
    /// <summary>Where this bar sits against its own target. 1.0 is exactly on it.</summary>
    public double Fraction => Target <= 0 ? 0 : Done / Target;

    public bool Short => Target > 0 && Done < Target;

    /// <summary>
    /// The same week split by side, for muscles that got one-limb work.
    ///
    /// Empty for anyone training bilaterally, which is most weeks for most people -- two extra
    /// rows under every muscle saying the same number twice would bury the chart. It appears when
    /// there is something to see, which is what the trainee asked the chart for.
    /// </summary>
    public IReadOnlyList<ProgressBar> Sides { get; init; } = [];
}

/// <summary>
/// The history chart: what the trainee has done this week, against whatever their program is
/// actually for.
///
/// The yardstick follows the goal, the same way <see cref="ProgramAnalyzer"/> already decides
/// whether to judge a plan by volume at all. The effective dose is a hypertrophy number. Holding
/// a conditioning circuit or a rehab program to it would mark someone short every week for
/// running exactly the program they asked for — so those are measured against the program's own
/// plan instead, which is the goal they actually signed up to.
/// </summary>
public sealed record WeeklyProgress(
    ProgressYardstick Yardstick,
    IReadOnlyList<ProgressBar> Bars,
    string Headline,
    string TargetLabel)
{
    public static readonly WeeklyProgress Nothing =
        new(ProgressYardstick.VolumeOnly, [], "", "");

    /// <summary>Whether there is a goal line to draw. VolumeOnly has nothing to mark.</summary>
    public bool HasTarget => Yardstick != ProgressYardstick.VolumeOnly;

    /// <summary>
    /// How far the axis runs, as a multiple of the target.
    ///
    /// At least 1.25 so the goal line sits inside the plot rather than flush against the right
    /// edge, where it would read as a border. Beyond that it follows the biggest bar, so someone
    /// at triple the dose can see that they are.
    /// </summary>
    public double AxisMax =>
        Bars.Count == 0 ? 1.25 : Math.Max(1.25, Bars.Max(b => b.Fraction));

    /// <summary>
    /// Bar width as a percentage of the plot, clamped to it.
    ///
    /// A bar with real work behind it never renders as nothing, and a bar with none never
    /// renders as something. Both directions are lies a rounding error can tell: half a set out
    /// of twelve is under one percent of the plot, and a CSS minimum width would put the same
    /// sliver against a session that has not been started.
    /// </summary>
    public double WidthPercent(ProgressBar bar)
    {
        ArgumentNullException.ThrowIfNull(bar);
        if (bar.Done <= 0) return 0;

        return Math.Clamp(100 * bar.Fraction / AxisMax, 1.5, 100);
    }

    /// <summary>Where the goal line falls, as a percentage across the plot.</summary>
    public double TargetPercent => 100 / AxisMax;
}

/// <summary>A logged workout, reduced to what the program-goal chart needs.</summary>
public sealed record LoggedSession(string? ProgramSessionId, DateOnly On, int Sets);

/// <summary>
/// Builds the history chart. Which of the two it builds is the whole decision; both shapes are
/// the same underneath.
/// </summary>
public static class WeeklyProgressReport
{
    public const int WindowDays = VolumeLedger.DefaultWindowDays;

    /// <summary>
    /// The chart for this trainee.
    ///
    /// Hypertrophy is decided from the AIM rather than from the program's emphasis, because the
    /// question here is what the trainee is training for, not what the program is built out of.
    /// Someone losing weight is running a hypertrophy program whether or not they would call it
    /// one — that is settled in docs/adr/0010 — and the dose is the right yardstick for both.
    /// </summary>
    public static WeeklyProgress For(
        TrainingAim aim,
        VolumeLedger ledger,
        VolumeTarget target,
        TrainingProgram? program,
        IEnumerable<LoggedSession> logged,
        ExerciseCatalog catalog,
        DateOnly asOf)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(target);

        if (aim.ToGoal() == GoalType.Hypertrophy)
        {
            return AgainstDose(ledger, target, asOf);
        }

        // No program to measure against -- someone training freestyle for endurance has no
        // planned figure anywhere. Showing their volume with no line is honest; inventing a
        // target for them would not be.
        return program is null
            ? VolumeWithoutTarget(ledger, asOf)
            : AgainstProgram(program, logged, catalog, asOf);
    }

    /// <summary>Sets per muscle this week against the dose where growth starts.</summary>
    public static WeeklyProgress AgainstDose(
        VolumeLedger ledger, VolumeTarget target, DateOnly asOf)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(target);

        // Muscles the trainee has never trained are left out, for the reason
        // VolumeLedger.BelowEffectiveDose already leaves them out: not training your calves is a
        // program choice, and a permanent empty bar for it is nagging rather than information.
        var bars = ledger.Summary(asOf, WindowDays)
            .Where(v => v.DaysSinceTrained is not null)
            // Biggest muscle first, not busiest. Ordering by sets would reshuffle the chart every
            // time the trainee logged anything, so a bar's position would carry no meaning and
            // week-to-week comparison would mean re-reading the labels. Anatomy does not move.
            .OrderByDescending(v => v.Muscle.RelativeMass())
            .ThenBy(v => v.Muscle.ToString(), StringComparer.Ordinal)
            .Select(v => new ProgressBar(
                Capitalize(v.Muscle.Label()),
                v.WeeklySets,
                target.MinimumEffectiveSets,
                $"{v.WeeklySets:0.#} of {target.MinimumEffectiveSets:0}")
            {
                Sides = SplitOf(v, target),
            })
            .ToList();

        if (bars.Count == 0)
        {
            return new WeeklyProgress(
                ProgressYardstick.EffectiveDose, bars,
                "Nothing logged in the last week.",
                $"{target.MinimumEffectiveSets:0} sets");
        }

        var atDose = bars.Count(b => !b.Short);

        return new WeeklyProgress(
            ProgressYardstick.EffectiveDose,
            bars,
            atDose == bars.Count
                ? $"All {bars.Count} muscle groups you train are at the "
                  + $"{target.MinimumEffectiveSets:0} sets where growth starts."
                : $"{atDose} of {bars.Count} muscle groups you train are at the "
                  + $"{target.MinimumEffectiveSets:0} sets where growth starts.",
            $"{target.MinimumEffectiveSets:0} sets");
    }

    /// <summary>
    /// The left/right rows under a muscle, and only when they say something.
    ///
    /// Shown when the two sides differ by a full set or more. Below that it is the rounding of
    /// half-counted sets rather than a real imbalance, and a chart that cries lopsided every week
    /// teaches people to ignore it.
    /// </summary>
    private static IReadOnlyList<ProgressBar> SplitOf(MuscleVolume v, VolumeTarget target)
    {
        if (!v.Sides.Lopsided) return [];

        return
        [
            new ProgressBar("Left", v.Sides.Left, target.MinimumEffectiveSets,
                $"{v.Sides.Left:0.#}"),
            new ProgressBar("Right", v.Sides.Right, target.MinimumEffectiveSets,
                $"{v.Sides.Right:0.#}"),
        ];
    }

    /// <summary>
    /// Sets logged this week against what one rotation of the program plans.
    ///
    /// One rotation counts as one week, the same convention <see cref="ProgramAnalyzer"/> uses
    /// and the one a program is written to (docs/adr/0007). Worth stating out loud: someone
    /// running a four-session rotation twice a week will read as double.
    /// </summary>
    public static WeeklyProgress AgainstProgram(
        TrainingProgram program,
        IEnumerable<LoggedSession> logged,
        ExerciseCatalog catalog,
        DateOnly asOf)
    {
        ArgumentNullException.ThrowIfNull(program);
        ArgumentNullException.ThrowIfNull(logged);

        var from = asOf.AddDays(-WindowDays);
        var recent = logged.Where(s => s.On > from && s.On <= asOf).ToList();

        var done = new Dictionary<string, int>(StringComparer.Ordinal);
        var offPlan = 0;

        foreach (var session in recent)
        {
            if (session.ProgramSessionId is { Length: > 0 } id
                && program.Sessions.Any(s => s.Id == id))
            {
                done[id] = done.GetValueOrDefault(id) + session.Sets;
            }
            else
            {
                offPlan += session.Sets;
            }
        }

        var bars = program.Sessions
            .Select(s => new
            {
                s.Name,
                Planned = (double)PlannedSets(s, catalog),
                Done = (double)done.GetValueOrDefault(s.Id),
            })
            .Select(s => new ProgressBar(
                s.Name, s.Done, s.Planned, $"{s.Done:0} of {s.Planned:0}"))
            .ToList();

        var totalDone = bars.Sum(b => b.Done);
        var totalPlanned = bars.Sum(b => b.Target);

        return new WeeklyProgress(
            ProgressYardstick.ProgramGoal,
            bars,
            Headline(totalDone, totalPlanned, offPlan),
            "a full rotation");
    }

    /// <summary>
    /// A PLAN against the dose, in the same shape as a logged week.
    ///
    /// The program tab and the history tab are answering the same question about two different
    /// things -- what this program would give you, and what this week actually did -- so they get
    /// the same bars in the same order with the line in the same place. They used to differ in
    /// both, and the program tab's note claimed a marker it never drew.
    ///
    /// Unlike a logged week, a muscle at zero keeps its bar. A plan is a complete statement of
    /// what you will do, so nothing in it is a gap in the record; history is a record where
    /// absence is ambiguous, which is why an untrained muscle is left out there.
    /// </summary>
    public static WeeklyProgress ForPlan(
        IReadOnlyList<PlannedMuscleVolume> volumes, VolumeTarget target)
    {
        ArgumentNullException.ThrowIfNull(volumes);
        ArgumentNullException.ThrowIfNull(target);

        var bars = volumes
            .OrderByDescending(v => v.Muscle.RelativeMass())
            .ThenBy(v => v.Muscle.ToString(), StringComparer.Ordinal)
            .Select(v => new ProgressBar(
                Capitalize(v.Muscle.Label()),
                v.WeeklySets,
                target.MinimumEffectiveSets,
                $"{v.WeeklySets:0.#} of {target.MinimumEffectiveSets:0}"))
            .ToList();

        return new WeeklyProgress(
            ProgressYardstick.EffectiveDose, bars, "", $"{target.MinimumEffectiveSets:0} sets");
    }

    /// <summary>Sets per muscle with no line, for a program-less trainee not chasing growth.</summary>
    public static WeeklyProgress VolumeWithoutTarget(VolumeLedger ledger, DateOnly asOf)
    {
        ArgumentNullException.ThrowIfNull(ledger);

        var summary = ledger.Summary(asOf, WindowDays)
            .Where(v => v.DaysSinceTrained is not null)
            // Biggest muscle first, not busiest. Ordering by sets would reshuffle the chart every
            // time the trainee logged anything, so a bar's position would carry no meaning and
            // week-to-week comparison would mean re-reading the labels. Anatomy does not move.
            .OrderByDescending(v => v.Muscle.RelativeMass())
            .ThenBy(v => v.Muscle.ToString(), StringComparer.Ordinal)
            .ToList();

        // Everything is scaled to the busiest muscle, so the bars still compare with each other
        // even though none of them is measured against anything.
        var most = summary.Count == 0 ? 0 : summary.Max(v => v.WeeklySets);

        var bars = summary
            .Select(v => new ProgressBar(
                Capitalize(v.Muscle.Label()), v.WeeklySets, most, MuscleGroups.Sets(v.WeeklySets)))
            .ToList();

        return new WeeklyProgress(
            ProgressYardstick.VolumeOnly,
            bars,
            bars.Count == 0
                ? "Nothing logged in the last week."
                : "What you trained in the last week. Follow a program and this becomes progress "
                  + "against its plan.",
            "");
    }

    private static int PlannedSets(ProgramSession session, ExerciseCatalog catalog)
    {
        // Counts only what a set of counts as work. A session of stretches plans zero sets, and
        // a bar with a zero target would otherwise read as permanently complete.
        return session.Exercises
            .Where(e => catalog?.TryGet(e.ExerciseId) is not { CountsAsVolume: false })
            .Sum(e => e.Sets);
    }

    private static string Headline(double done, double planned, int offPlan)
    {
        var extra = offPlan == 0
            ? ""
            : $" Another {MuscleGroups.Sets(offPlan)} outside the program.";

        if (planned <= 0) return $"Your program plans no working sets yet.{extra}";
        if (done <= 0) return $"Nothing from your program logged in the last week.{extra}";

        var share = done / planned;

        return share switch
        {
            >= 1.5 => $"You have done {done:0} sets against the {planned:0} one rotation plans — "
                      + $"half a rotation clear of it.{extra}",
            >= 1.05 => $"You have done {done:0} sets against the {planned:0} one rotation plans, "
                       + $"so you are past a full rotation.{extra}",
            >= 0.95 => $"You have done {done:0} of the {planned:0} sets one rotation plans. "
                       + $"That is the week.{extra}",
            // Not :P0 -- the invariant culture the browser runtime falls back to renders that as
            // "86 %", with a space, which reads as a typo in an English sentence.
            _ => $"You have done {done:0} of the {planned:0} sets one rotation plans, "
                 + $"{(1 - share) * 100:0}% short.{extra}",
        };
    }

    private static string Capitalize(string text) =>
        text.Length == 0 ? text : char.ToUpperInvariant(text[0]) + text[1..];
}
