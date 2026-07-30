using TotalGymLogBook.Domain.Training;
using Xunit;

namespace TotalGymLogBook.Domain.Tests.Training;

public class ProgressionEngineTests
{
    private static readonly RailProfile Anniversary = RepoData.Profiles()["rail-14"];
    private static readonly DateOnly Today = new(2026, 3, 1);
    private static readonly ProgressionEngine Engine = new();

    private static readonly EquipmentInventory Typical = new([
        new EquipmentItem(EquipmentKind.VestBlock, 2.5, 8),
        new EquipmentItem(EquipmentKind.BarPlate, 2.5, 2),
        new EquipmentItem(EquipmentKind.BarPlate, 5.0, 2),
        new EquipmentItem(EquipmentKind.BarPlate, 10.0, 2)
    ]);

    private static readonly TrainingGoal Hypertrophy = new(GoalType.Hypertrophy);
    private static readonly Phase Maintaining = new(EnergyBalance.Maintenance, 0, false);
    private static readonly Phase Cutting = new(EnergyBalance.Deficit, -1.0, false);
    private static readonly Phase Bulking = new(EnergyBalance.Surplus, 0.5, false);

    private static LoadLadder Ladder(double bodyweightLb = 180, EquipmentInventory? kit = null) =>
        new(Anniversary, bodyweightLb, kit ?? EquipmentInventory.None);

    /// <summary>A session of <paramref name="sets"/> sets at a level, all at the same reps.</summary>
    private static ExerciseHistory Session(int level, int reps, double bodyweightLb = 180,
        double vestLb = 0, double barLb = 0, int sets = 3)
    {
        var lb = ResistanceCalculator.Compute(Anniversary, new ResistanceInputs
        {
            BodyweightLb = bodyweightLb, Level = level, VestLb = vestLb, BarLb = barLb
        });

        return new ExerciseHistory("chest-press", Enumerable.Range(0, sets)
            .Select(_ => new SetRecord(Today.AddDays(-3), reps, Math.Round(lb, 1), level, vestLb, barLb))
            .ToList());
    }

    // ---------------------------------------------------------------- starting out

    [Fact]
    public void NoHistory_StartsWhereLevelStepsAreManageable()
    {
        var rec = Engine.NextSession(ExerciseHistory.Empty("chest-press"), Hypertrophy,
            Phase.Unknown, Ladder());

        Assert.Equal(ProgressionLever.StartingPoint, rec.Lever);
        Assert.InRange(rec.Level, 4, 7);
        Assert.Equal(0, rec.AddedLb);
        Assert.Equal(8, rec.TargetReps);
    }

    // ---------------------------------------------------------------- reps before load

    [Fact]
    public void BelowTheRepCeiling_AddsRepsRatherThanLoad()
    {
        var rec = Engine.NextSession(Session(level: 8, reps: 9), Hypertrophy, Maintaining, Ladder());

        Assert.Equal(ProgressionLever.AddReps, rec.Lever);
        Assert.Equal(8, rec.Level);
        Assert.Equal(10, rec.TargetReps);
    }

    [Fact]
    public void AtTheRepCeiling_StepsTheLoad()
    {
        var rec = Engine.NextSession(Session(level: 8, reps: 12), Hypertrophy, Maintaining, Ladder());

        Assert.NotEqual(ProgressionLever.AddReps, rec.Lever);
        Assert.True(rec.TargetLb > Session(8, 12).LastSession[0].ComputedLb);
        Assert.Equal(8, rec.TargetReps); // back to the bottom of the range
    }

    // ---------------------------------------------------------------- lever selection

    [Fact]
    public void InTheMidRange_PrefersALevelIncrease()
    {
        // Level 8 -> 9 is a ~8% step: the right size, and no equipment fiddling.
        var rec = Engine.NextSession(Session(level: 8, reps: 12), Hypertrophy, Maintaining,
            Ladder(kit: Typical));

        Assert.Equal(ProgressionLever.IncreaseLevel, rec.Lever);
        Assert.Equal(9, rec.Level);
        Assert.Equal(0, rec.AddedLb);
    }

    [Fact]
    public void LowDownTheRail_UsesAddedWeightBecauseALevelWouldJumpTooFar()
    {
        // Level 1 -> 2 is a ~21% jump. docs/adr/0004: the "prefer levels" rule has an
        // exception at the BOTTOM of the range as well as at the ceiling.
        var rec = Engine.NextSession(Session(level: 1, reps: 12), Hypertrophy, Maintaining,
            Ladder(kit: Typical));

        Assert.Equal(ProgressionLever.AddWeight, rec.Lever);
        Assert.Equal(1, rec.Level);
        Assert.True(rec.AddedLb > 0);
        Assert.Contains("jump too far", rec.Rationale);
    }

    [Fact]
    public void AtMaxLevel_TheOnlyLeverIsAddedWeight()
    {
        var rec = Engine.NextSession(Session(level: 14, reps: 12), Hypertrophy, Maintaining,
            Ladder(kit: Typical));

        Assert.Equal(ProgressionLever.AddWeight, rec.Lever);
        Assert.Equal(14, rec.Level);
        Assert.True(rec.AddedLb > 0);
        Assert.Contains("highest level", rec.Rationale);
    }

    [Fact]
    public void AtMaxLevelWithNoEquipment_SaysSoInsteadOfInventingAnIncrement()
    {
        var rec = Engine.NextSession(Session(level: 14, reps: 12), Hypertrophy, Maintaining,
            Ladder(kit: EquipmentInventory.None));

        Assert.Equal(ProgressionLever.Hold, rec.Lever);
        Assert.Contains("vest or plates", rec.Rationale);
    }

    // ---------------------------------------------------------------- the deficit rules

    [Fact]
    public void Cutting_HoldsLoadInsteadOfChasingPrs()
    {
        var rec = Engine.NextSession(Session(level: 8, reps: 12), Hypertrophy, Cutting, Ladder());

        Assert.Equal(ProgressionLever.Hold, rec.Lever);
        Assert.Contains("keeping your lifts steady is the win", rec.Rationale);
    }

    [Fact]
    public void Cutting_CompensatesWhenBodyweightHasActuallyFallen()
    {
        // Trained at level 8 weighing 180; now weighs 165. Same notch yields ~4 lb less.
        var history = Session(level: 8, reps: 12, bodyweightLb: 180);
        var rec = Engine.NextSession(history, Hypertrophy, Cutting, Ladder(bodyweightLb: 165));

        Assert.Equal(ProgressionLever.CompensateBodyweight, rec.Lever);
        Assert.True(rec.TargetLb >= history.LastSession[0].ComputedLb - ProgressionEngine.TargetToleranceLb,
            "the whole point is to restore the load that was lost to bodyweight");
        Assert.Contains("hold onto muscle while losing fat", rec.Rationale);
    }

    [Fact]
    public void Cutting_ExplainsTheDropRatherThanLettingItLookLikeRegression()
    {
        var rec = Engine.NextSession(Session(level: 8, reps: 12, bodyweightLb: 180),
            Hypertrophy, Cutting, Ladder(bodyweightLb: 165));

        Assert.Contains("You're lighter than last time", rec.Rationale);
        Assert.Contains("now gives", rec.Rationale);
    }

    [Fact]
    public void Bulking_ProgressesNormally()
    {
        var rec = Engine.NextSession(Session(level: 8, reps: 12), Hypertrophy, Bulking, Ladder());
        Assert.Equal(ProgressionLever.IncreaseLevel, rec.Lever);
    }

    // ---------------------------------------------------------------- goals

    [Fact]
    public void Rehab_NeverPushesLoad()
    {
        // A coach nagging a rehab user to add weight is actively harmful. docs/adr/0010.
        var rec = Engine.NextSession(Session(level: 8, reps: 15), new TrainingGoal(GoalType.Rehab),
            Maintaining, Ladder(kit: Typical));

        Assert.Equal(ProgressionLever.Hold, rec.Lever);
        Assert.Equal(8, rec.Level);
        Assert.Contains("consistently", rec.Rationale);
    }

    [Fact]
    public void Strength_UsesLowerRepsAndABiggerLoadStep()
    {
        var strength = new TrainingGoal(GoalType.Strength);
        var hyper = Hypertrophy.Parameters;
        var str = strength.Parameters;

        Assert.True(str.MaxReps < hyper.MinReps);
        Assert.True(str.LoadStepFraction > hyper.LoadStepFraction);
        Assert.True(str.RestBetweenSets > hyper.RestBetweenSets);
    }

    [Fact]
    public void Aerobic_UsesHighRepsAndTheSmallestLoadStep()
    {
        var aerobic = new TrainingGoal(GoalType.Aerobic).Parameters;

        Assert.True(aerobic.MinReps > Hypertrophy.Parameters.MaxReps);
        Assert.True(aerobic.LoadStepFraction < Hypertrophy.Parameters.LoadStepFraction);
    }

    [Fact]
    public void GoalsCanBeCombined()
    {
        var goal = new TrainingGoal(GoalType.Hypertrophy, GoalType.Aerobic);

        Assert.True(goal.Includes(GoalType.Hypertrophy));
        Assert.True(goal.Includes(GoalType.Aerobic));
        Assert.False(goal.Includes(GoalType.Rehab));
        Assert.Equal(GoalType.Hypertrophy, goal.Parameters.Goal); // primary drives the rules
    }

    // ---------------------------------------------------------------- invariants

    [Fact]
    public void NeverRecommendsGoingBackwards()
    {
        var ladder = Ladder(kit: Typical);

        for (var level = 1; level <= Anniversary.LevelCount; level++)
        foreach (var phase in new[] { Maintaining, Bulking, Cutting, Phase.Unknown })
        {
            var history = Session(level, reps: 12);
            var rec = Engine.NextSession(history, Hypertrophy, phase, ladder);

            Assert.True(rec.Level >= level,
                $"level {level} in {phase.Balance} produced a recommendation to drop to {rec.Level}");
        }
    }

    [Fact]
    public void AlwaysRecommendsSomethingReachable()
    {
        var ladder = Ladder(kit: Typical);

        for (var level = 1; level <= Anniversary.LevelCount; level++)
        {
            var rec = Engine.NextSession(Session(level, reps: 12), Hypertrophy, Maintaining, ladder);

            var reachable = ladder.Rungs.Any(r =>
                r.Level == rec.Level
                && Math.Abs(r.VestLb - rec.VestLb) < 0.01
                && Math.Abs(r.BarLb - rec.BarLb) < 0.01);

            Assert.True(reachable, $"recommendation at level {level} is not on the ladder");
        }
    }

    [Fact]
    public void RationaleIsAlwaysPlainLanguage()
    {
        var jargon = new[] { "deficit", "surplus", "phase", "RIR", "hypertrophy", "lever" };
        var ladder = Ladder(kit: Typical);

        foreach (var phase in new[] { Maintaining, Bulking, Cutting, Phase.Unknown })
        foreach (var reps in new[] { 9, 12 })
        {
            var rec = Engine.NextSession(Session(8, reps), Hypertrophy, phase, ladder);
            foreach (var word in jargon)
            {
                Assert.DoesNotContain(word, rec.Rationale, StringComparison.OrdinalIgnoreCase);
            }
        }
    }
}
