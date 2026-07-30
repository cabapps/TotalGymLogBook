using Xunit;

namespace TotalGymLogBook.Domain.Tests;

public class ResistanceCalculatorTests
{
    private static readonly RailProfileTable Profiles = RepoData.Profiles();
    private static readonly RailProfile Anniversary = Profiles["rail-14"];

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(15)]
    public void RejectsOutOfRangeLevels(int level)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            ResistanceCalculator.Compute(Anniversary,
                new ResistanceInputs { BodyweightLb = 180, Level = level }));
    }

    [Fact]
    public void RejectsNegativeLoads()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => ResistanceCalculator.Compute(
            Anniversary, new ResistanceInputs { BodyweightLb = -1, Level = 5 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => ResistanceCalculator.Compute(
            Anniversary, new ResistanceInputs { BodyweightLb = 180, Level = 5, VestLb = -1 }));
        Assert.Throws<ArgumentOutOfRangeException>(() => ResistanceCalculator.Compute(
            Anniversary, new ResistanceInputs { BodyweightLb = 180, Level = 5, BarLb = -1 }));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-0.5)]
    [InlineData(1.5)]
    public void RejectsBodyFractionOutsideZeroToOne(double fraction)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => ResistanceCalculator.Compute(
            Anniversary,
            new ResistanceInputs { BodyweightLb = 180, Level = 5, BodyFraction = fraction }));
    }

    [Fact]
    public void ResistanceIncreasesMonotonicallyWithLevel()
    {
        foreach (var profile in Profiles.Profiles)
        {
            var previous = double.NegativeInfinity;
            for (var level = 1; level <= profile.LevelCount; level++)
            {
                var current = ResistanceCalculator.Compute(profile,
                    new ResistanceInputs { BodyweightLb = 180, Level = level });

                Assert.True(current > previous,
                    $"{profile.Id} level {level} ({current:0.0}) did not exceed level {level - 1} ({previous:0.0}).");
                previous = current;
            }
        }
    }

    [Fact]
    public void EmptyGlideboardStillHasResistance()
    {
        // The board's own mass rides the incline, which is exactly why the published charts
        // are linear-with-offset rather than proportional. See docs/adr/0004.
        var bare = ResistanceCalculator.Compute(Anniversary,
            new ResistanceInputs { BodyweightLb = 0, Level = 14 });

        Assert.Equal(Anniversary.BoardWeightLb * Math.Sin(double.DegreesToRadians(25.5)), bare, 10);
        Assert.True(bare > 0);
    }

    [Fact]
    public void DirectLoadIsNotDiscountedByTheIncline()
    {
        var withoutDirect = ResistanceCalculator.Compute(Anniversary,
            new ResistanceInputs { BodyweightLb = 180, Level = 3 });
        var withDirect = ResistanceCalculator.Compute(Anniversary,
            new ResistanceInputs { BodyweightLb = 180, Level = 3, DirectLoadLb = 10 });

        Assert.Equal(10, withDirect - withoutDirect, 10);
    }

    [Fact]
    public void BarIsNotScaledByBodyFractionButVestIs()
    {
        var baseline = new ResistanceInputs { BodyweightLb = 180, Level = 8, BodyFraction = 0.5 };

        var withBar = ResistanceCalculator.Compute(Anniversary, baseline with { BarLb = 10 })
                      - ResistanceCalculator.Compute(Anniversary, baseline);
        var withVest = ResistanceCalculator.Compute(Anniversary, baseline with { VestLb = 10 })
                       - ResistanceCalculator.Compute(Anniversary, baseline);

        Assert.Equal(withBar / 2, withVest, 10);
    }

    [Fact]
    public void ProfileTable_LooksUpByNotchCount()
    {
        // Onboarding asks for notch count, not model name: the FIT and FIT Anniversary share
        // a name but have 12 and 14 levels. See docs/adr/0010.
        Assert.Equal("rail-14", Profiles.ForLevelCount(14).Id);
        Assert.Equal("rail-12", Profiles.ForLevelCount(12).Id);
        Assert.Throws<KeyNotFoundException>(() => Profiles.ForLevelCount(13));
    }

    [Fact]
    public void Rail10_IsMarkedUnverified()
    {
        var rail10 = Profiles["rail-10"];
        Assert.Equal(AngleSource.Derived, rail10.AngleSource);
        Assert.False(rail10.Verified,
            "rail-10's published angle column is corrupt; angles are back-solved and need " +
            "tape-measure confirmation before shipping. See docs/adr/0004.");
    }
}
