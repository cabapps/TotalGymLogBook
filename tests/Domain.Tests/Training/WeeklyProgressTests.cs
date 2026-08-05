using TotalGymLogBook.Domain.Training;
using Xunit;

namespace TotalGymLogBook.Domain.Tests.Training;

/// <summary>
/// The history chart. Two questions, one shape -- and the thing worth testing hardest is that
/// the right question gets asked, because the wrong one is not obviously wrong on screen. A
/// rehab trainee marked short of a hypertrophy dose every week just looks like a trainee who is
/// behind.
/// </summary>
public class WeeklyProgressTests
{
    private static readonly DateOnly Today = new(2026, 3, 15);
    private static readonly VolumeTarget Target = VolumeTarget.For(ExperienceLevel.Novice);

    private static readonly Exercise ChestPress = new()
    {
        Id = "chest-press",
        Name = "Chest Press",
        Muscles = [
            MuscleInvolvement.Primary(MuscleGroup.Chest),
            MuscleInvolvement.Secondary(MuscleGroup.Triceps)
        ]
    };

    private static readonly Exercise Squat = new()
    {
        Id = "squat",
        Name = "Squat",
        Muscles = [MuscleInvolvement.Primary(MuscleGroup.Quadriceps)]
    };

    private static readonly Exercise Stretch = new()
    {
        Id = "lat-stretch",
        Name = "Lat Stretch",
        Kind = ExerciseKind.Stretch,
        Muscles = [MuscleInvolvement.Primary(MuscleGroup.Back)]
    };

    private static readonly Dictionary<string, Exercise> ById = new()
    {
        [ChestPress.Id] = ChestPress,
        [Squat.Id] = Squat,
        [Stretch.Id] = Stretch,
    };

    private static readonly ExerciseCatalog Catalog = new ExerciseCatalog(ById.Values);

    private static ExerciseHistory Sets(Exercise e, int sets, int daysAgo) =>
        new(e.Id, Enumerable.Range(0, sets)
            .Select(_ => new SetRecord(Today.AddDays(-daysAgo), 10, 50, 8)).ToList());

    private static TrainingProgram Program(params (string Id, string Name, int Sets)[] sessions) =>
        new("p", "Test",
            sessions
                .Select(s => new ProgramSession(
                    s.Id, s.Name, [new PlannedExercise("squat", s.Sets)]))
                .ToList());

    // ---------------------------------------------------------------- which yardstick

    [Theory]
    [InlineData(TrainingAim.BuildMuscle)]
    [InlineData(TrainingAim.LoseFat)]
    public void Hypertrophy_aims_are_measured_against_the_dose(TrainingAim aim)
    {
        // Losing weight is a hypertrophy program whether or not the trainee would call it one
        // (docs/adr/0010), so it gets the dose too -- keeping muscle is the whole job there.
        var progress = WeeklyProgressReport.For(
            aim, new VolumeLedger([Sets(ChestPress, 6, 2)], ById), Target,
            Program(("s1", "Full Body", 4)), [], Catalog, Today);

        Assert.Equal(ProgressYardstick.EffectiveDose, progress.Yardstick);
    }

    [Theory]
    [InlineData(TrainingAim.GetStronger)]
    [InlineData(TrainingAim.Endurance)]
    [InlineData(TrainingAim.Rehab)]
    public void Other_aims_are_measured_against_their_program(TrainingAim aim)
    {
        var progress = WeeklyProgressReport.For(
            aim, new VolumeLedger([Sets(ChestPress, 6, 2)], ById), Target,
            Program(("s1", "Full Body", 4)), [], Catalog, Today);

        Assert.Equal(ProgressYardstick.ProgramGoal, progress.Yardstick);
    }

    [Fact]
    public void With_no_program_and_no_growth_goal_there_is_nothing_to_measure_against()
    {
        // Inventing a target for a freestyle rehab trainee would be worse than drawing no line.
        var progress = WeeklyProgressReport.For(
            TrainingAim.Rehab, new VolumeLedger([Sets(ChestPress, 6, 2)], ById), Target,
            program: null, [], Catalog, Today);

        Assert.Equal(ProgressYardstick.VolumeOnly, progress.Yardstick);
        Assert.False(progress.HasTarget);
        Assert.NotEmpty(progress.Bars);
    }

    // ---------------------------------------------------------------- against the dose

    [Fact]
    public void A_muscle_at_the_dose_is_not_short_and_one_under_it_is()
    {
        // Six sets of chest press: chest 6, triceps 3. The dose is 4.
        var progress = WeeklyProgressReport.AgainstDose(
            new VolumeLedger([Sets(ChestPress, 6, 2)], ById), Target, Today);

        var chest = progress.Bars.Single(b => b.Label == "Chest");
        var triceps = progress.Bars.Single(b => b.Label == "Triceps");

        Assert.False(chest.Short);
        Assert.Equal(1.5, chest.Fraction);
        Assert.True(triceps.Short);
        Assert.Equal(0.75, triceps.Fraction);
    }

    [Fact]
    public void Bars_run_biggest_muscle_first()
    {
        // Anatomy, not activity. Ordering by sets would reshuffle the chart on every logged set,
        // so a bar's position would mean nothing and no two weeks would be comparable at a
        // glance. Quads outrank back outrank chest outrank triceps on any human.
        var progress = WeeklyProgressReport.AgainstDose(
            new VolumeLedger([Sets(ChestPress, 8, 2), Sets(Squat, 1, 2)], ById), Target, Today);

        Assert.Equal(["Quads", "Chest", "Triceps"], progress.Bars.Select(b => b.Label));
    }

    [Fact]
    public void Muscles_never_trained_get_no_bar()
    {
        // The reason VolumeLedger.BelowEffectiveDose leaves them out too: a permanent empty bar
        // for calves is nagging someone about a program choice they already made.
        var progress = WeeklyProgressReport.AgainstDose(
            new VolumeLedger([Sets(ChestPress, 6, 2)], ById), Target, Today);

        Assert.DoesNotContain(progress.Bars, b => b.Label == "Calves");
        Assert.Contains(progress.Bars, b => b.Label == "Chest");
    }

    [Fact]
    public void Work_older_than_the_window_still_earns_a_bar_but_no_sets()
    {
        // Trained a fortnight ago: the muscle is theirs, so it is shown -- at zero, which is the
        // gap the chart exists to surface.
        var progress = WeeklyProgressReport.AgainstDose(
            new VolumeLedger([Sets(Squat, 5, daysAgo: 14)], ById), Target, Today);

        var quads = progress.Bars.Single(b => b.Label == "Quads");
        Assert.Equal(0, quads.Done);
        Assert.True(quads.Short);
    }

    [Fact]
    public void The_axis_leaves_room_past_the_goal_line()
    {
        // Otherwise the line lands on the right edge and reads as a border rather than a target.
        var onTarget = WeeklyProgressReport.AgainstDose(
            new VolumeLedger([Sets(Squat, 4, 1)], ById), Target, Today);

        Assert.Equal(1.25, onTarget.AxisMax);
        Assert.Equal(80, onTarget.TargetPercent);

        // And it stretches for someone well past it, so tripling the dose looks like tripling it.
        var wayOver = WeeklyProgressReport.AgainstDose(
            new VolumeLedger([Sets(Squat, 12, 1)], ById), Target, Today);

        Assert.Equal(3.0, wayOver.AxisMax);
        Assert.Equal(100, wayOver.WidthPercent(wayOver.Bars.Single(b => b.Label == "Quads")));
    }

    [Fact]
    public void A_bar_is_empty_only_when_nothing_was_done()
    {
        // Both directions are lies a rounding error tells. A session not started must not show
        // the same sliver as one with a set in it, and half a set out of twelve must not vanish.
        var progress = WeeklyProgressReport.AgainstProgram(
            Program(("a", "A", 40), ("b", "B", 40)),
            [new LoggedSession("a", Today.AddDays(-1), 1)],
            Catalog, Today);

        var started = progress.Bars.Single(b => b.Label == "A");
        var untouched = progress.Bars.Single(b => b.Label == "B");

        Assert.Equal(0, progress.WidthPercent(untouched));
        Assert.True(progress.WidthPercent(started) >= 1.5);
    }

    // ---------------------------------------------------------------- a plan against the dose

    [Fact]
    public void A_plan_is_charted_the_same_way_round_as_a_week()
    {
        // The program tab and the history tab answer the same question about a planned week and
        // a logged one. Different orderings would make a bar's position mean two things.
        var plan = WeeklyProgressReport.ForPlan(
        [
            new PlannedMuscleVolume(MuscleGroup.Biceps, 6, 4),
            new PlannedMuscleVolume(MuscleGroup.Quadriceps, 2, 4),
            new PlannedMuscleVolume(MuscleGroup.Back, 4, 4),
        ], Target);

        Assert.Equal(["Quads", "Back", "Biceps"], plan.Bars.Select(b => b.Label));
        Assert.True(plan.HasTarget);

        // And the axis behaves the same way too: biceps at six against a dose of four stretches
        // it to 1.5, which pulls the line in from the edge to two thirds across.
        Assert.Equal(1.5, plan.AxisMax);
        Assert.Equal(100 / 1.5, plan.TargetPercent, 6);
    }

    [Fact]
    public void A_planned_muscle_at_zero_keeps_its_bar()
    {
        // Unlike a logged week. A plan is a complete statement of what you will do, so a muscle
        // at zero is the plan saying something; in history it is only an absence.
        var plan = WeeklyProgressReport.ForPlan(
            [new PlannedMuscleVolume(MuscleGroup.Calves, 0, 4)], Target);

        Assert.Equal("Calves", Assert.Single(plan.Bars).Label);
    }

    // ---------------------------------------------------------------- against the program

    [Fact]
    public void Each_session_is_measured_against_its_own_planned_sets()
    {
        var program = Program(("push", "Push", 9), ("pull", "Pull", 6));

        var progress = WeeklyProgressReport.AgainstProgram(
            program,
            [
                new LoggedSession("push", Today.AddDays(-2), 9),
                new LoggedSession("pull", Today.AddDays(-1), 3),
            ],
            Catalog, Today);

        var push = progress.Bars.Single(b => b.Label == "Push");
        var pull = progress.Bars.Single(b => b.Label == "Pull");

        Assert.False(push.Short);
        Assert.Equal(1.0, push.Fraction);
        Assert.True(pull.Short);
        Assert.Equal(0.5, pull.Fraction);
    }

    [Fact]
    public void Sets_outside_the_window_do_not_count()
    {
        var progress = WeeklyProgressReport.AgainstProgram(
            Program(("push", "Push", 9)),
            [new LoggedSession("push", Today.AddDays(-30), 9)],
            Catalog, Today);

        Assert.Equal(0, progress.Bars.Single().Done);
    }

    [Fact]
    public void Freestyle_work_is_counted_but_not_as_program_progress()
    {
        // A session with no program stamp is real work and says so in the headline. Folding it
        // into a session's bar would claim they did planned work they did not do.
        var progress = WeeklyProgressReport.AgainstProgram(
            Program(("push", "Push", 9)),
            [
                new LoggedSession("push", Today.AddDays(-2), 4),
                new LoggedSession(null, Today.AddDays(-1), 5),
            ],
            Catalog, Today);

        Assert.Equal(4, progress.Bars.Single().Done);
        Assert.Contains("outside the program", progress.Headline, StringComparison.Ordinal);
    }

    [Fact]
    public void A_session_stamped_from_a_program_they_have_since_left_counts_as_off_plan()
    {
        var progress = WeeklyProgressReport.AgainstProgram(
            Program(("push", "Push", 9)),
            [new LoggedSession("some-old-session", Today.AddDays(-1), 5)],
            Catalog, Today);

        Assert.Equal(0, progress.Bars.Single().Done);
        Assert.Contains("outside the program", progress.Headline, StringComparison.Ordinal);
    }

    [Fact]
    public void Exceeding_the_rotation_is_said_out_loud()
    {
        var progress = WeeklyProgressReport.AgainstProgram(
            Program(("push", "Push", 6)),
            [new LoggedSession("push", Today.AddDays(-1), 12)],
            Catalog, Today);

        Assert.Contains("clear of it", progress.Headline, StringComparison.Ordinal);
        Assert.False(progress.Bars.Single().Short);
    }

    [Fact]
    public void A_session_of_stretches_plans_no_working_sets()
    {
        // A zero target would make the bar read as permanently complete.
        var program = new TrainingProgram("p", "Test",
        [
            new ProgramSession("s1", "Mobility", [new PlannedExercise("lat-stretch", 3)]),
        ]);

        var progress = WeeklyProgressReport.AgainstProgram(program, [], Catalog, Today);

        Assert.Equal(0, progress.Bars.Single().Target);
        Assert.Contains("no working sets", progress.Headline, StringComparison.Ordinal);
    }
}
