using TotalGymLogBook.Domain.Training;
using Xunit;

namespace TotalGymLogBook.Domain.Tests.Training;

public class LoadLadderTests
{
    private static readonly RailProfile Anniversary = RepoData.Profiles()["rail-14"];

    /// <summary>A 20 lb vest in 2.5 lb blocks, plus a pair each of 2.5/5/10 lb plates.</summary>
    private static readonly EquipmentInventory Typical = new([
        new EquipmentItem(EquipmentKind.VestBlock, 2.5, 8),
        new EquipmentItem(EquipmentKind.BarPlate, 2.5, 2),
        new EquipmentItem(EquipmentKind.BarPlate, 5.0, 2),
        new EquipmentItem(EquipmentKind.BarPlate, 10.0, 2)
    ]);

    [Fact]
    public void WithNoEquipment_TheLadderIsJustTheLevels()
    {
        var ladder = new LoadLadder(Anniversary, 180, EquipmentInventory.None);

        Assert.Equal(Anniversary.LevelCount, ladder.Rungs.Count);
        Assert.All(ladder.Rungs, r => Assert.Equal(0, r.AddedLb));
    }

    [Fact]
    public void EquipmentMultipliesTheAvailableRungs()
    {
        var bare = new LoadLadder(Anniversary, 180, EquipmentInventory.None);
        var kitted = new LoadLadder(Anniversary, 180, Typical);

        Assert.True(kitted.Rungs.Count > bare.Rungs.Count * 10);
    }

    [Fact]
    public void OnlySuggestsWeightsTheTraineeActuallyOwns()
    {
        // Blocks are 2.5 lb, so 3 lb of vest is not reachable and must never be offered.
        var ladder = new LoadLadder(Anniversary, 180, Typical);

        Assert.All(ladder.Rungs, r =>
        {
            Assert.Equal(0, r.VestLb % 2.5, 6);
            Assert.True(r.VestLb <= 20.0);
            Assert.True(r.BarLb <= 35.0); // 2*(2.5+5+10)
        });
    }

    [Fact]
    public void StepFraction_ShowsLevelsAreCoarseAtTheBottomAndFineAtTheTop()
    {
        // The claim in docs/adr/0004 that makes the coach's lever choice non-obvious.
        var ladder = new LoadLadder(Anniversary, 180, EquipmentInventory.None);

        Assert.True(ladder.StepFractionAbove(1) > 0.18, "level 1->2 should be a big relative jump");
        Assert.True(ladder.StepFractionAbove(13) < 0.08, "level 13->14 should be a small one");
        Assert.Null(ladder.StepFractionAbove(Anniversary.LevelCount));
    }

    [Fact]
    public void LevelStepsAreNearUniformInPounds()
    {
        var ladder = new LoadLadder(Anniversary, 180, EquipmentInventory.None);

        for (var level = 1; level < Anniversary.LevelCount; level++)
        {
            var step = ladder.BareLoad(level + 1) - ladder.BareLoad(level);
            Assert.InRange(step, 4.3, 5.3);
        }
    }

    [Fact]
    public void AddedWeightBridgesTheGapBetweenLevels()
    {
        // Why micro-progression works. Measured on a 14-notch rail at 180 lb: the largest gap
        // between consecutive achievable loads falls from 4.9 lb bare to 1.1 lb with a vest and
        // plates. The residual 1.1 lb is the coarsest point in the range -- 2.5 lb of plate at
        // 25.5 degrees -- so this is granularity, not a defect.
        var bare = new LoadLadder(Anniversary, 180, EquipmentInventory.None);
        var kitted = new LoadLadder(Anniversary, 180, Typical);

        static double LargestGap(LoadLadder l)
        {
            var loads = l.Rungs.Select(r => r.ComputedLb).Distinct().Order().ToList();
            return loads.Zip(loads.Skip(1), (a, b) => b - a).DefaultIfEmpty(0).Max();
        }

        var bareGap = LargestGap(bare);
        var kittedGap = LargestGap(kitted);

        Assert.True(bareGap > 4.0, $"bare rail should step ~4.9 lb, got {bareGap:0.0}");
        Assert.True(kittedGap < bareGap / 3,
            $"equipment should shrink the largest gap at least threefold; "
            + $"{bareGap:0.0} lb -> {kittedGap:0.0} lb");
    }

    [Fact]
    public void SmallestAtLeast_FindsTheCheapestQualifyingRung()
    {
        var ladder = new LoadLadder(Anniversary, 180, Typical);
        var rung = ladder.SmallestAtLeast(60.0);

        Assert.NotNull(rung);
        Assert.True(rung.ComputedLb >= 60.0 - 0.05);
        // Nothing cheaper should also qualify.
        Assert.DoesNotContain(ladder.Rungs,
            r => r.ComputedLb >= 60.0 - 0.05 && r.ComputedLb < rung.ComputedLb);
    }

    [Fact]
    public void PulleyExercisesHalveEveryRung()
    {
        var direct = new LoadLadder(Anniversary, 180, EquipmentInventory.None);
        var cable = new LoadLadder(Anniversary, 180, EquipmentInventory.None, usesPulley: true);

        for (var level = 1; level <= Anniversary.LevelCount; level++)
        {
            // Compare with a tolerance rather than to a decimal place: BareLoad rounds to
            // 0.1 lb, so halving a rounded figure and rounding a halved figure legitimately
            // differ by up to half a quantum (32.3/2 = 16.15 against a computed 16.1).
            Assert.True(Math.Abs(direct.BareLoad(level) / 2 - cable.BareLoad(level)) <= 0.06,
                $"level {level}: {direct.BareLoad(level)} direct vs {cable.BareLoad(level)} cable");
        }
    }

    [Fact]
    public void LosingWeightLowersEveryRung()
    {
        // The problem the coach exists to solve, visible in the ladder itself.
        var heavier = new LoadLadder(Anniversary, 180, EquipmentInventory.None);
        var lighter = new LoadLadder(Anniversary, 160, EquipmentInventory.None);

        for (var level = 1; level <= Anniversary.LevelCount; level++)
        {
            Assert.True(lighter.BareLoad(level) < heavier.BareLoad(level));
        }

        // At level 8 the drop exceeds a whole level step -- more than 20 lb of bodyweight.
        var oneStep = heavier.BareLoad(8) - heavier.BareLoad(7);
        Assert.True(heavier.BareLoad(8) - lighter.BareLoad(8) > oneStep);
    }
}
