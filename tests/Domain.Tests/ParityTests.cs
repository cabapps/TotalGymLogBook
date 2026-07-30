using System.Text.Json.Serialization;
using Xunit;

namespace TotalGymLogBook.Domain.Tests;

/// <summary>
/// Asserts the C# resistance calculator matches the committed golden file.
///
/// The mirrored TypeScript implementation asserts against the same file in
/// src/client/test/resistance.parity.test.ts, so either side drifting fails its own suite,
/// and an intentional formula change appears as a reviewable diff. See docs/adr/0009.
/// </summary>
public class ParityTests
{
    private static readonly RailProfileTable Profiles = RepoData.Profiles();
    private static readonly ResistanceCasesFile Cases =
        RepoData.ReadJson<ResistanceCasesFile>("resistance-cases.json");
    private static readonly ResistanceExpectedFile Expected =
        RepoData.ReadJson<ResistanceExpectedFile>("resistance-expected.json");

    [Fact]
    public void FixturesAgreeOnFormulaVersion()
    {
        Assert.Equal(ResistanceCalculator.FormulaVersion, Cases.FormulaVersion);
        Assert.Equal(ResistanceCalculator.FormulaVersion, Expected.FormulaVersion);
        Assert.Equal(ResistanceCalculator.OutputDecimals, Expected.OutputDecimals);
        Assert.Equal(ResistanceCalculator.FormulaVersion, Profiles.FormulaVersion);
    }

    [Fact]
    public void EveryCaseHasAnExpectedValue()
    {
        var missing = Cases.Cases.Where(c => !Expected.Expected.ContainsKey(c.Id)).ToList();
        Assert.True(missing.Count == 0,
            $"{missing.Count} cases have no golden value. Re-run tools/GenerateExpected.\n" +
            string.Join("\n", missing.Take(10).Select(c => "  " + c.Id)));

        var orphaned = Expected.Expected.Keys.Except(Cases.Cases.Select(c => c.Id)).ToList();
        Assert.True(orphaned.Count == 0,
            $"{orphaned.Count} golden values have no matching case. Re-run tools/GenerateExpected.");
    }

    [Fact]
    public void AllCasesMatchGoldenFile()
    {
        var failures = new List<string>();

        foreach (var c in Cases.Cases)
        {
            var actual = ResistanceCalculator.ComputeRounded(Profiles[c.ProfileId], c.ToInputs());
            var expected = Expected.Expected[c.Id];

            if (actual != expected)
            {
                failures.Add($"  {c.Id}: expected {expected}, got {actual}");
            }
        }

        Assert.True(failures.Count == 0,
            $"{failures.Count}/{Cases.Cases.Count} cases drifted from the golden file. " +
            "If the formula change was deliberate, re-run tools/GenerateExpected and review the diff.\n" +
            string.Join("\n", failures.Take(20)));
    }

    [Fact]
    public void CasesCoverEveryLevelOfEveryProfile()
    {
        foreach (var profile in Profiles.Profiles)
        for (var level = 1; level <= profile.LevelCount; level++)
        {
            Assert.Contains(Cases.Cases, c => c.ProfileId == profile.Id && c.Level == level);
        }
    }
}

internal sealed record ResistanceCasesFile(
    [property: JsonPropertyName("formulaVersion")] int FormulaVersion,
    [property: JsonPropertyName("cases")] IReadOnlyList<ResistanceCaseDto> Cases);

internal sealed record ResistanceExpectedFile(
    [property: JsonPropertyName("formulaVersion")] int FormulaVersion,
    [property: JsonPropertyName("outputDecimals")] int OutputDecimals,
    [property: JsonPropertyName("expected")] IReadOnlyDictionary<string, double> Expected);

internal sealed record ResistanceCaseDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("profileId")] string ProfileId,
    [property: JsonPropertyName("level")] int Level,
    [property: JsonPropertyName("bodyweightLb")] double BodyweightLb,
    [property: JsonPropertyName("usesPulley")] bool UsesPulley,
    [property: JsonPropertyName("bodyFraction")] double BodyFraction,
    [property: JsonPropertyName("vestLb")] double VestLb,
    [property: JsonPropertyName("barLb")] double BarLb,
    [property: JsonPropertyName("directLoadLb")] double DirectLoadLb)
{
    public ResistanceInputs ToInputs() => new()
    {
        BodyweightLb = BodyweightLb,
        Level = Level,
        UsesPulley = UsesPulley,
        BodyFraction = BodyFraction,
        VestLb = VestLb,
        BarLb = BarLb,
        DirectLoadLb = DirectLoadLb
    };
}
