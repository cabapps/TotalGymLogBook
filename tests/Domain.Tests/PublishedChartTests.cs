using Xunit;

namespace TotalGymLogBook.Domain.Tests;

/// <summary>
/// Validates the physical model in docs/adr/0004 against Total Gym's published resistance
/// figures. This is the test that matters most: boardWeightLb was DERIVED by regression, so
/// if these drift, the derivation is wrong.
/// </summary>
public class PublishedChartTests
{
    /// <summary>
    /// Charts round to whole pounds, so +/- 0.5 lb is unavoidable. Measured fit across all
    /// 567 points is: mean 0.26, p95 0.50, max 0.83 (rail-10 L5 @ 210 lb). 1.0 lb is therefore
    /// a real regression guard rather than a rubber stamp -- if a profile's boardWeightLb or
    /// an angle is wrong, the error lands well outside this.
    /// </summary>
    private const double ToleranceLb = 1.0;

    private static readonly RailProfileTable Profiles = RepoData.Profiles();
    private static readonly PublishedChartFile Chart =
        RepoData.ReadJson<PublishedChartFile>("published-chart-samples.json");

    public static TheoryData<string, int> Rows()
    {
        var data = new TheoryData<string, int>();
        var file = RepoData.ReadJson<PublishedChartFile>("published-chart-samples.json");
        foreach (var row in file.Samples) data.Add(row.ProfileId, row.Level);
        return data;
    }

    [Theory]
    [MemberData(nameof(Rows))]
    public void ComputedResistance_MatchesPublishedChart(string profileId, int level)
    {
        var profile = Profiles[profileId];
        var row = Chart.Samples.Single(s => s.ProfileId == profileId && s.Level == level);

        Assert.Equal(Chart.BodyweightLb.Count, row.PublishedLb.Count);

        var failures = new List<string>();

        for (var i = 0; i < Chart.BodyweightLb.Count; i++)
        {
            var bodyweight = Chart.BodyweightLb[i];
            var expected = row.PublishedLb[i];
            var actual = ResistanceCalculator.Compute(
                profile, new ResistanceInputs { BodyweightLb = bodyweight, Level = level });

            var delta = Math.Abs(actual - expected);
            if (delta > ToleranceLb)
            {
                failures.Add($"  {bodyweight,5} lb -> expected {expected,6:0.0}, got {actual,6:0.0} (off by {delta:0.00})");
            }
        }

        Assert.True(failures.Count == 0,
            $"{profileId} level {level} ({profile.AngleForLevel(level)} deg, board {profile.BoardWeightLb} lb) " +
            $"missed on {failures.Count}/{Chart.BodyweightLb.Count} bodyweights:\n" +
            string.Join("\n", failures));
    }

    /// <summary>
    /// The pulley rule is published as a flat halving: "If the pulley cables are used in the
    /// exercise, use 50% of the charted numbers."
    /// </summary>
    [Fact]
    public void PulleyExercises_AreExactlyHalf()
    {
        var profile = Profiles["rail-14"];

        for (var level = 1; level <= profile.LevelCount; level++)
        {
            var direct = ResistanceCalculator.Compute(profile,
                new ResistanceInputs { BodyweightLb = 180, Level = level });
            var cable = ResistanceCalculator.Compute(profile,
                new ResistanceInputs { BodyweightLb = 180, Level = level, UsesPulley = true });

            Assert.Equal(direct / 2, cable, precision: 10);
        }
    }

    /// <summary>
    /// The claim from docs/adr/0004 that drives the coach's compensation rule: bodyweight and
    /// added weight sit in the same term multiplied by the same sin(angle), so offsetting N lb
    /// of bodyweight loss takes exactly N lb of vest, at any level on any machine.
    /// </summary>
    [Theory]
    [InlineData("rail-6")]
    [InlineData("rail-8")]
    [InlineData("rail-10")]
    [InlineData("rail-12")]
    [InlineData("rail-14")]
    public void VestCompensatesBodyweightLoss_OneForOne(string profileId)
    {
        var profile = Profiles[profileId];

        for (var level = 1; level <= profile.LevelCount; level++)
        foreach (var lost in new[] { 5d, 12d, 20d, 35d })
        {
            var before = ResistanceCalculator.Compute(profile,
                new ResistanceInputs { BodyweightLb = 200, Level = level });

            var afterWithVest = ResistanceCalculator.Compute(profile,
                new ResistanceInputs { BodyweightLb = 200 - lost, Level = level, VestLb = lost });

            Assert.Equal(before, afterWithVest, precision: 10);
        }
    }
}
