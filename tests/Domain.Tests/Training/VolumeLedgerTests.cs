using TotalGymLogBook.Domain.Training;
using Xunit;

namespace TotalGymLogBook.Domain.Tests.Training;

public class VolumeLedgerTests
{
    private static readonly DateOnly Today = new(2026, 3, 15);

    private static readonly Exercise ChestPress = new()
    {
        Id = "chest-press",
        Name = "Chest Press",
        UsesPulley = true,
        Muscles = [
            MuscleInvolvement.Primary(MuscleGroup.Chest),
            MuscleInvolvement.Secondary(MuscleGroup.Triceps),
            MuscleInvolvement.Secondary(MuscleGroup.Shoulders)
        ]
    };

    private static readonly Exercise SeatedRow = new()
    {
        Id = "seated-row",
        Name = "Seated Row",
        UsesPulley = true,
        BodyFraction = 0.7,
        Muscles = [
            MuscleInvolvement.Primary(MuscleGroup.Back),
            MuscleInvolvement.Secondary(MuscleGroup.Biceps)
        ]
    };

    private static readonly Exercise Squat = new()
    {
        Id = "squat",
        Name = "Squat",
        Attachment = "squat stand",
        Muscles = [
            MuscleInvolvement.Primary(MuscleGroup.Quadriceps),
            MuscleInvolvement.Primary(MuscleGroup.Glutes),
            MuscleInvolvement.Secondary(MuscleGroup.Hamstrings)
        ]
    };

    private static readonly Exercise SingleLegSquat = new()
    {
        Id = "single-leg-squat",
        Name = "Single-Leg Squat",
        Unilateral = true,
        Muscles = [MuscleInvolvement.Primary(MuscleGroup.Quadriceps)]
    };

    private static readonly Dictionary<string, Exercise> Catalog = new()
    {
        [ChestPress.Id] = ChestPress,
        [SeatedRow.Id] = SeatedRow,
        [Squat.Id] = Squat,
        [SingleLegSquat.Id] = SingleLegSquat
    };

    private static ExerciseHistory SidedSets(
        Exercise e, int left, int right, int daysAgo = 1)
    {
        var on = Today.AddDays(-daysAgo);
        var sets = Enumerable.Range(0, left)
            .Select(_ => new SetRecord(on, 10, 50, 8, Side: BodySide.Left))
            .Concat(Enumerable.Range(0, right)
                .Select(_ => new SetRecord(on, 10, 50, 8, Side: BodySide.Right)));

        return new ExerciseHistory(e.Id, sets.ToList());
    }

    // ---------------------------------------------------------------- one limb at a time

    [Fact]
    public void ThreeSetsPerLegIsThreeSetsForEachQuad()
    {
        // Not six. Six is what the logbook holds and what the trainee did on the board, but each
        // quad got three -- and three is the figure comparable to three two-legged squats, which
        // is what the effective dose is a number about.
        var ledger = new VolumeLedger([SidedSets(SingleLegSquat, left: 3, right: 3)], Catalog);

        Assert.Equal(3.0, ledger.WeeklySets(Today)[MuscleGroup.Quadriceps]);
    }

    [Fact]
    public void KeepsTheTwoSidesApart()
    {
        var ledger = new VolumeLedger([SidedSets(SingleLegSquat, left: 4, right: 2)], Catalog);
        var sides = ledger.WeeklySides(Today)[MuscleGroup.Quadriceps];

        Assert.Equal(4, sides.Left);
        Assert.Equal(2, sides.Right);
        Assert.Equal(3, sides.Average);
        Assert.True(sides.Lopsided);
    }

    [Fact]
    public void ABilateralSetFeedsBothSides()
    {
        // Which is what makes the average comparable across the two kinds of movement: three
        // two-legged squats is three for each leg, exactly as three per leg is.
        var ledger = new VolumeLedger([Sets(Squat, 3, daysAgo: 1)], Catalog);
        var sides = ledger.WeeklySides(Today)[MuscleGroup.Quadriceps];

        Assert.Equal(3, sides.Left);
        Assert.Equal(3, sides.Right);
        Assert.False(sides.Lopsided);
    }

    [Fact]
    public void AUnilateralSetWithNoRecordedSideIsSplit()
    {
        // Sets logged before the app asked. Half to each keeps the total honest without inventing
        // an imbalance that never happened -- and without counting one leg's work as two.
        var ledger = new VolumeLedger([Sets(SingleLegSquat, 6, daysAgo: 1)], Catalog);
        var sides = ledger.WeeklySides(Today)[MuscleGroup.Quadriceps];

        Assert.Equal(3, sides.Left);
        Assert.Equal(3, sides.Right);
        Assert.Equal(3, ledger.WeeklySets(Today)[MuscleGroup.Quadriceps]);
    }

    [Fact]
    public void ASideDifferenceUnderAFullSetIsNotAnImbalance()
    {
        // Half-counted sets round; a chart that cried lopsided every week would teach people to
        // ignore it.
        var ledger = new VolumeLedger([SidedSets(SingleLegSquat, left: 3, right: 3)], Catalog);

        Assert.False(ledger.WeeklySides(Today)[MuscleGroup.Quadriceps].Lopsided);
    }

    private static ExerciseHistory Sets(Exercise e, int sets, int daysAgo)
    {
        var on = Today.AddDays(-daysAgo);
        return new ExerciseHistory(e.Id, Enumerable.Range(0, sets)
            .Select(_ => new SetRecord(on, 10, 50, 8)).ToList());
    }

    // ---------------------------------------------------------------- fractional accounting

    [Fact]
    public void IndirectWorkCountsAsHalfASet()
    {
        // 4 sets of chest press: 4 for chest, 2 each for triceps and shoulders.
        var ledger = new VolumeLedger([Sets(ChestPress, 4, daysAgo: 2)], Catalog);
        var weekly = ledger.WeeklySets(Today);

        Assert.Equal(4.0, weekly[MuscleGroup.Chest]);
        Assert.Equal(2.0, weekly[MuscleGroup.Triceps]);
        Assert.Equal(2.0, weekly[MuscleGroup.Shoulders]);
    }

    [Fact]
    public void AnExerciseCanHaveTwoPrimeMovers()
    {
        var ledger = new VolumeLedger([Sets(Squat, 3, daysAgo: 1)], Catalog);
        var weekly = ledger.WeeklySets(Today);

        Assert.Equal(3.0, weekly[MuscleGroup.Quadriceps]);
        Assert.Equal(3.0, weekly[MuscleGroup.Glutes]);
        Assert.Equal(1.5, weekly[MuscleGroup.Hamstrings]);
    }

    [Fact]
    public void ContributionsAccumulateAcrossExercises()
    {
        // Why fractional accounting matters: pressing and rowing both feed the arms, and
        // counting either at full weight would badly overstate arm volume.
        var ledger = new VolumeLedger(
            [Sets(ChestPress, 4, 3), Sets(SeatedRow, 4, 2)], Catalog);
        var weekly = ledger.WeeklySets(Today);

        Assert.Equal(4.0, weekly[MuscleGroup.Chest]);
        Assert.Equal(4.0, weekly[MuscleGroup.Back]);
        Assert.Equal(2.0, weekly[MuscleGroup.Triceps]);
        Assert.Equal(2.0, weekly[MuscleGroup.Biceps]);
    }

    [Fact]
    public void OnlyCountsTheTrailingWindow()
    {
        var ledger = new VolumeLedger(
            [Sets(ChestPress, 5, daysAgo: 3), Sets(ChestPress, 5, daysAgo: 20)], Catalog);

        Assert.Equal(5.0, ledger.WeeklySets(Today)[MuscleGroup.Chest]);
        Assert.Equal(10.0, ledger.WeeklySets(Today, windowDays: 30)[MuscleGroup.Chest]);
    }

    [Fact]
    public void UnknownExercisesAreIgnoredRatherThanThrowing()
    {
        var ledger = new VolumeLedger(
            [new ExerciseHistory("not-in-catalog", [new SetRecord(Today, 10, 50, 8)])], Catalog);

        Assert.Empty(ledger.WeeklySets(Today));
    }

    // ---------------------------------------------------------------- targets

    [Fact]
    public void MinimumEffectiveDoseIsFourSetsAtEveryExperienceLevel()
    {
        foreach (var level in Enum.GetValues<ExperienceLevel>())
        {
            Assert.Equal(4.0, VolumeTarget.For(level).MinimumEffectiveSets);
        }
    }

    [Fact]
    public void RecommendedVolumeScalesWithExperience()
    {
        var novice = VolumeTarget.For(ExperienceLevel.Novice).RecommendedSets;
        var intermediate = VolumeTarget.For(ExperienceLevel.Intermediate).RecommendedSets;
        var advanced = VolumeTarget.For(ExperienceLevel.Advanced).RecommendedSets;

        Assert.True(novice < intermediate);
        Assert.True(intermediate < advanced);
    }

    [Fact]
    public void ThereIsNoUpperBound()
    {
        // Deliberate: the app cannot observe recovery, so it does not police a ceiling.
        // 40 sets of chest is not flagged as anything.
        var ledger = new VolumeLedger([Sets(ChestPress, 40, daysAgo: 2)], Catalog);
        var target = VolumeTarget.For(ExperienceLevel.Novice);

        Assert.Equal(40.0, ledger.WeeklySets(Today)[MuscleGroup.Chest]);
        Assert.Empty(ledger.BelowEffectiveDose(Today, target));
        Assert.DoesNotContain(ledger.Nudges(Today, target), n => n.Contains("chest"));
    }

    [Fact]
    public void ADeficitHoldsVolumeSteadyRatherThanCappingIt()
    {
        // docs/adr/0010 asks for more conservatism in a deficit. With no ceiling, that lands
        // as "stop recommending increases", never as a cap or a warning.
        var maintaining = VolumeTarget.For(ExperienceLevel.Intermediate, EnergyBalance.Maintenance);
        var cutting = VolumeTarget.For(ExperienceLevel.Intermediate, EnergyBalance.Deficit);

        Assert.True(cutting.RecommendedSets < maintaining.RecommendedSets);
        Assert.Equal(maintaining.MinimumEffectiveSets, cutting.MinimumEffectiveSets);
    }

    [Fact]
    public void ADeficitNeverDropsTheRecommendationBelowTheEffectiveDose()
    {
        var cutting = VolumeTarget.For(ExperienceLevel.Novice, EnergyBalance.Deficit);
        Assert.True(cutting.RecommendedSets >= VolumeTarget.MinimumEffectiveDose);
    }

    // ---------------------------------------------------------------- nudges

    [Fact]
    public void FlagsMusclesTrainedButUnderTheEffectiveDose()
    {
        // Two sets of rowing: back gets 2, under the 4-set floor.
        var ledger = new VolumeLedger([Sets(SeatedRow, 2, daysAgo: 2)], Catalog);
        var below = ledger.BelowEffectiveDose(Today, VolumeTarget.For(ExperienceLevel.Novice));

        Assert.Contains(below, v => v.Muscle == MuscleGroup.Back);
    }

    [Fact]
    public void DoesNotNagAboutMusclesNeverTrained()
    {
        // Not training calves is a program choice, not a gap to be scolded about.
        var ledger = new VolumeLedger([Sets(ChestPress, 6, daysAgo: 2)], Catalog);
        var below = ledger.BelowEffectiveDose(Today, VolumeTarget.For(ExperienceLevel.Novice));

        Assert.DoesNotContain(below, v => v.Muscle == MuscleGroup.Calves);
        Assert.All(ledger.Nudges(Today, VolumeTarget.For(ExperienceLevel.Novice)),
            n => Assert.DoesNotContain("calves", n));
    }

    [Fact]
    public void FlagsNeglectedMuscleGroups()
    {
        // The "you haven't pulled in 12 days" nudge from docs/adr/0007.
        var ledger = new VolumeLedger(
            [Sets(ChestPress, 4, daysAgo: 2), Sets(SeatedRow, 4, daysAgo: 12)], Catalog);

        var nudges = ledger.Nudges(Today, VolumeTarget.For(ExperienceLevel.Novice));
        Assert.Contains(nudges, n => n.Contains("back") && n.Contains("12 days"));
    }

    [Fact]
    public void DaysSinceTrained_CountsIndirectWorkToo()
    {
        // Triceps got no direct work, but pressing three days ago still counts as involvement.
        var ledger = new VolumeLedger([Sets(ChestPress, 4, daysAgo: 3)], Catalog);

        Assert.Equal(3, ledger.DaysSinceTrained(MuscleGroup.Triceps, Today));
        Assert.Null(ledger.DaysSinceTrained(MuscleGroup.Calves, Today));
    }

    [Fact]
    public void SummaryOrdersByNeglect()
    {
        var ledger = new VolumeLedger(
            [Sets(ChestPress, 6, daysAgo: 2), Sets(SeatedRow, 2, daysAgo: 2)], Catalog);

        var summary = ledger.Summary(Today);
        Assert.Equal(Enum.GetValues<MuscleGroup>().Length, summary.Count);
        Assert.True(summary[0].WeeklySets <= summary[^1].WeeklySets);
        Assert.Equal(MuscleGroup.Chest, summary[^1].Muscle); // most trained, last
    }

    [Fact]
    public void NudgesArePlainLanguage()
    {
        var ledger = new VolumeLedger(
            [Sets(ChestPress, 1, daysAgo: 2), Sets(SeatedRow, 1, daysAgo: 14)], Catalog);

        var jargon = new[] { "MEV", "volume landmark", "hypertrophy", "deficit", "sets/muscle" };
        foreach (var nudge in ledger.Nudges(Today, VolumeTarget.For(ExperienceLevel.Novice)))
        {
            foreach (var word in jargon)
            {
                Assert.DoesNotContain(word, nudge, StringComparison.OrdinalIgnoreCase);
            }
        }
    }
}
