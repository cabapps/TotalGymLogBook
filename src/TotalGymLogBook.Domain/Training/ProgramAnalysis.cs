namespace TotalGymLogBook.Domain.Training;

public sealed record PlannedExercise(string ExerciseId, int Sets);

public sealed record ProgramSession(string Id, string Name, IReadOnlyList<PlannedExercise> Exercises);

/// <summary>
/// A training program: an ordered rotation of sessions.
///
/// Ordered, not scheduled — there is no day-of-week here, deliberately (docs/adr/0007). Which
/// session comes next is derived in the shell, because that answer drives the exercise picker
/// and the picker has to work before the .NET runtime exists. What lives here is the harder
/// question: whether the program is any good.
/// </summary>
public sealed record TrainingProgram(
    string Id,
    string Name,
    IReadOnlyList<ProgramSession> Sessions);

/// <summary>How a program's planned sets are distributed across the tension profiles.</summary>
public sealed record TensionMix(double Lengthened, double Even, double Shortened)
{
    public double Total => Lengthened + Even + Shortened;

    /// <summary>Share of planned sets loaded in the stretch, 0–1. Zero when nothing is planned.</summary>
    public double LengthenedShare => Total <= 0 ? 0 : Lengthened / Total;
}

/// <summary>Planned weekly volume for one muscle, against the target.</summary>
public sealed record PlannedMuscleVolume(MuscleGroup Muscle, double WeeklySets, double MinimumSets)
{
    /// <summary>
    /// True when something in the program drives this muscle DIRECTLY.
    ///
    /// The distinction the set count alone cannot make. Adductors turn up at 1.5 sets in a
    /// push/pull/legs split because a wide-stance squat involves them a little -- but nobody
    /// writes a PPL to train adductors, and calling that a program that trains them badly is
    /// criticizing it for something it never claimed. Half a set falling out of somebody else's
    /// movement is picked up, not programmed.
    /// </summary>
    public bool Direct { get; init; }

    public bool BelowMinimum => WeeklySets < MinimumSets;
    public bool Untrained => WeeklySets <= 0;
}

public sealed record ProgramCritique(
    IReadOnlyList<PlannedMuscleVolume> Volumes,
    IReadOnlyList<string> Warnings,
    string Untrained,
    string Verdict)
{
    /// <summary>What the program is built out of, against what the trainee is training for.</summary>
    public string EmphasisNote { get; init; } = "";

    public TensionMix Tension { get; init; } = new(0, 0, 0);

    /// <summary>Muscles the program trains, but under the dose where growth starts.</summary>
    public IReadOnlyList<PlannedMuscleVolume> Shortfalls =>
        Volumes.Where(v => v.BelowMinimum && !v.Untrained).ToList();
}

/// <summary>
/// What a program actually delivers, before anyone runs it for six weeks and wonders why their
/// arms did not grow.
///
/// This is the payoff for counting volume the way <see cref="VolumeLedger"/> does: the same
/// per-muscle, fractional accounting applied to a PLAN rather than to history. A trainee can see
/// that push/pull/legs gives their calves three sets a week before committing, instead of
/// discovering it in the ledger a month later.
///
/// One rotation is treated as one week. That is the convention a program is written to
/// (docs/adr/0007), and it is what makes the numbers comparable to the weekly targets in
/// <see cref="VolumeTarget"/>. It is also an assumption worth stating out loud: someone running
/// a four-session rotation twice a week is getting double these figures.
/// </summary>
public sealed class ProgramAnalyzer
{
    /// <summary>Planned sets per muscle for one full rotation, indirect work counted fractionally.</summary>
    public IReadOnlyDictionary<MuscleGroup, double> WeeklySets(
        TrainingProgram program, ExerciseCatalog catalog)
    {
        ArgumentNullException.ThrowIfNull(program);
        ArgumentNullException.ThrowIfNull(catalog);

        var totals = new Dictionary<MuscleGroup, double>();

        foreach (var planned in program.Sessions.SelectMany(s => s.Exercises))
        {
            var exercise = catalog.TryGet(planned.ExerciseId);

            // A plan can outlive the movement it names — a deleted custom exercise, or a
            // template entry the trainee removed. Skipping it understates the total, which is
            // the safe direction: it can only make the app suggest more work, never less.
            if (exercise is null || !exercise.CountsAsVolume) continue;

            foreach (var involvement in exercise.Muscles)
            {
                totals[involvement.Muscle] =
                    totals.GetValueOrDefault(involvement.Muscle) + planned.Sets * involvement.Fraction;
            }
        }

        return totals;
    }

    /// <summary>
    /// The plan judged against the target, in plain language.
    ///
    /// Reports gaps only. A program that trains something hard is not criticized for it, for
    /// the same reason the ledger has no ceiling: nothing here can observe recovery
    /// (docs/adr/0010).
    /// </summary>
    /// <summary>Muscles some movement in the program drives directly. See PlannedMuscleVolume.Direct.</summary>
    public IReadOnlySet<MuscleGroup> DirectlyTrained(TrainingProgram program, ExerciseCatalog catalog)
    {
        ArgumentNullException.ThrowIfNull(program);
        ArgumentNullException.ThrowIfNull(catalog);

        var direct = new HashSet<MuscleGroup>();

        foreach (var planned in program.Sessions.SelectMany(s => s.Exercises))
        {
            var exercise = catalog.TryGet(planned.ExerciseId);
            if (exercise is null || !exercise.CountsAsVolume) continue;

            foreach (var m in exercise.Muscles.Where(m => m.Fraction >= MuscleInvolvement.Direct))
            {
                direct.Add(m.Muscle);
            }
        }

        return direct;
    }

    /// <summary>Planned sets split by where in the range they load the muscle.</summary>
    public TensionMix Tension(TrainingProgram program, ExerciseCatalog catalog)
    {
        ArgumentNullException.ThrowIfNull(program);
        ArgumentNullException.ThrowIfNull(catalog);

        double lengthened = 0, even = 0, shortened = 0;

        foreach (var planned in program.Sessions.SelectMany(s => s.Exercises))
        {
            var exercise = catalog.TryGet(planned.ExerciseId);
            if (exercise is null || !exercise.CountsAsVolume) continue;

            switch (exercise.PeakTension)
            {
                case PeakTension.Lengthened: lengthened += planned.Sets; break;
                case PeakTension.Shortened: shortened += planned.Sets; break;
                default: even += planned.Sets; break;
            }
        }

        return new TensionMix(lengthened, even, shortened);
    }

    public ProgramCritique Critique(
        TrainingProgram program,
        ExerciseCatalog catalog,
        VolumeTarget target,
        ProgramEmphasis emphasis = ProgramEmphasis.Lengthened)
    {
        ArgumentNullException.ThrowIfNull(target);

        var planned = WeeklySets(program, catalog);

        var direct = DirectlyTrained(program, catalog);

        var volumes = Enum.GetValues<MuscleGroup>()
            .Select(m => new PlannedMuscleVolume(
                m, planned.GetValueOrDefault(m), target.MinimumEffectiveSets)
            {
                Direct = direct.Contains(m),
            })
            .OrderBy(v => v.WeeklySets)
            .ToList();

        // Untrained and under-dosed are different, and only one of them is a problem.
        //
        // A muscle at zero is almost always a deliberate choice about what the split covers --
        // hardly any real program isolates the adductors, and an app that calls that a defect
        // is wrong about three of its own shipped templates. A muscle the program DOES train
        // but leaves at two sets is a different thing entirely: the intent is there and the dial
        // is just set too low. That one is worth saying.
        //
        // Same line SessionAdvisor already draws for logged history (docs/adr/0010). Two
        // features making opposite claims about the same idea would be worse than either.
        // THE YARDSTICK FOLLOWS THE GOAL. The effective dose is a hypertrophy number. Holding a
        // rehab program or a conditioning circuit to it would have the app calling a program a
        // failure for being exactly what the trainee asked for -- and it would be measuring
        // against a target that literature never set for those goals in the first place.
        var judgeByVolume = emphasis
            is ProgramEmphasis.Lengthened
            or ProgramEmphasis.LargestMuscles
            or ProgramEmphasis.HeavyCompounds;

        var warnings = !judgeByVolume
            ? []
            : volumes
            .Where(v => v.Direct && v.BelowMinimum)
            .Select(v => $"{Capitalize(v.Muscle.Label())} {v.Muscle.IsAre()} at "
                         + $"{MuscleGroups.Sets(v.WeeklySets)} a rotation, under the "
                         + $"{target.MinimumEffectiveSets:0} where growth starts.")
            .ToList();

        var untrained = volumes.Where(v => v.Untrained).ToList();
        var untrainedNote = untrained.Count == 0
            ? ""
            : $"Nothing in it trains {Join(untrained.Select(v => v.Muscle.Label()))} — "
              + "fine if that is deliberate.";

        var tension = Tension(program, catalog);

        return new ProgramCritique(volumes, warnings, untrainedNote, Verdict(volumes, warnings, target))
        {
            Tension = tension,
            EmphasisNote = EmphasisNote(emphasis, tension),
        };
    }

    /// <summary>
    /// Whether the program is built the way this trainee's goal calls for, in a sentence.
    ///
    /// Advisory, like everything else here. A program can be perfectly good and not match the
    /// emphasis: the trainee may know something about their own shoulder that the app does not.
    /// </summary>
    private static string EmphasisNote(ProgramEmphasis emphasis, TensionMix tension)
    {
        if (tension.Total <= 0) return "";

        var share = tension.LengthenedShare;

        return emphasis switch
        {
            // Percentages spelled out rather than :P0, which the invariant culture the browser
            // runtime falls back to renders as "67 %" -- a space that reads as a typo mid-sentence.
            ProgramEmphasis.Lengthened when share >= 0.5 =>
                $"{share * 100:0}% of these sets load the muscle stretched, which is where this "
                + "machine builds the most. Good shape for growth.",
            ProgramEmphasis.Lengthened =>
                $"Only {share * 100:0}% of these sets load the muscle stretched. Swapping a squeeze "
                + "movement for a fly, a pulldown or a deeper squat would do more for growth.",
            ProgramEmphasis.LargestMuscles =>
                "Built around the biggest muscles, which is what protects lean mass while you "
                + "are losing weight.",
            ProgramEmphasis.HeavyCompounds =>
                "Built around heavy compound movements. Rest longer than feels necessary between "
                + "sets — that is what keeps the next one heavy.",
            ProgramEmphasis.Circuit =>
                "Built for pace rather than load, so the weekly set counts below matter less "
                + "than keeping the sessions close together.",
            ProgramEmphasis.Gentle =>
                "Built to be repeatable rather than hard. Volume targets do not apply here — "
                + "work to what you are cleared for.",
            _ => ""
        };
    }

    private static string Verdict(
        IReadOnlyList<PlannedMuscleVolume> volumes,
        IReadOnlyList<string> warnings,
        VolumeTarget target)
    {
        var totalSets = volumes.Sum(v => v.WeeklySets);
        if (totalSets <= 0) return "This program has nothing in it yet.";

        if (warnings.Count == 0)
        {
            return $"Everything this program trains gets at least {target.MinimumEffectiveSets:0} "
                   + "sets a rotation. Run it as written and the volume takes care of itself.";
        }

        var thin = warnings.Count;
        return $"{thin} muscle group{(thin == 1 ? "" : "s")} you train in this program "
               + $"{(thin == 1 ? "is" : "are")} under "
               + $"{target.MinimumEffectiveSets:0} sets a rotation. Worth a look if "
               + $"{(thin == 1 ? "it matters" : "they matter")} to you.";
    }

    private static string Join(IEnumerable<string> parts)
    {
        var list = parts.ToList();
        return list.Count switch
        {
            0 => "",
            1 => list[0],
            2 => $"{list[0]} or {list[1]}",
            _ => $"{string.Join(", ", list.Take(list.Count - 1))}, or {list[^1]}"
        };
    }

    private static string Capitalize(string text) =>
        text.Length == 0 ? text : char.ToUpperInvariant(text[0]) + text[1..];
}
