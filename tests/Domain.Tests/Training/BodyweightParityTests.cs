using System.Text.Json.Serialization;
using TotalGymLogBook.Domain.Training;
using Xunit;

namespace TotalGymLogBook.Domain.Tests.Training;

/// <summary>
/// Asserts the C# smoothing matches the committed golden file, which
/// src/client/test/bodyweight.test.ts asserts against too.
///
/// Smoothing is the second thing implemented in both languages. The smoothed value feeds the
/// resistance calculation at log time, so it has to exist in TypeScript; the same golden-file
/// treatment as the resistance calculator keeps the two from drifting (docs/adr/0009).
///
/// Note only the EMA is mirrored. Phase inference -- the least-squares rate, hysteresis, and
/// the significance gate -- lives in C# alone, because it is derived rather than instant-path.
/// </summary>
public class BodyweightParityTests
{
    private static readonly BodyweightCasesFile Cases =
        RepoData.ReadJson<BodyweightCasesFile>("bodyweight-cases.json");

    private static readonly BodyweightExpectedFile Expected =
        RepoData.ReadJson<BodyweightExpectedFile>("bodyweight-expected.json");

    [Fact]
    public void FixturesAgreeOnTheSmoothingConstant()
    {
        Assert.Equal(BodyweightTrend.EmaAlpha, Cases.EmaAlpha);
        Assert.Equal(BodyweightTrend.EmaAlpha, Expected.EmaAlpha);
    }

    [Fact]
    public void EveryCaseHasAGoldenValue()
    {
        var missing = Cases.Cases.Where(c => !Expected.Expected.ContainsKey(c.Id)).ToList();
        Assert.True(missing.Count == 0,
            $"{missing.Count} cases have no golden value. Re-run tools/GenerateExpected.");

        var orphaned = Expected.Expected.Keys.Except(Cases.Cases.Select(c => c.Id)).ToList();
        Assert.True(orphaned.Count == 0,
            $"{orphaned.Count} golden values have no case. Re-run tools/GenerateExpected.");
    }

    [Fact]
    public void AllCasesMatchTheGoldenFile()
    {
        var failures = new List<string>();

        foreach (var c in Cases.Cases)
        {
            var trend = new BodyweightTrend(
                c.Readings.Select(r => new BodyweightReading(DateOnly.Parse(r.On), r.Lb)));

            var actual = Math.Round(trend.SmoothedLb!.Value, Expected.Decimals);
            var expected = Expected.Expected[c.Id];

            if (Math.Abs(actual - expected) > 1e-6)
            {
                failures.Add($"  {c.Id}: expected {expected}, got {actual}");
            }
        }

        Assert.True(failures.Count == 0,
            $"{failures.Count}/{Cases.Cases.Count} cases drifted. If deliberate, re-run "
            + "tools/GenerateExpected and review the diff.\n" + string.Join("\n", failures));
    }

    /// <summary>
    /// The behavior smoothing exists for: one noisy day must not move the number the load
    /// calculation uses by anything like the size of the noise.
    /// </summary>
    [Fact]
    public void ASingleSpikeMovesTheSmoothedValueFarLessThanTheRaw()
    {
        var start = new DateOnly(2026, 1, 1);
        var steady = Enumerable.Range(0, 9)
            .Select(i => new BodyweightReading(start.AddDays(i), 180)).ToList();

        var withSpike = steady.Append(new BodyweightReading(start.AddDays(9), 186)).ToList();

        var before = new BodyweightTrend(steady).SmoothedLb!.Value;
        var after = new BodyweightTrend(withSpike).SmoothedLb!.Value;

        Assert.Equal(180, before, 6);
        Assert.True(after - before < 2.0,
            $"a 6 lb spike moved the smoothed weight by {after - before:0.00} lb");
    }
}

internal sealed record BodyweightCasesFile(
    [property: JsonPropertyName("emaAlpha")] double EmaAlpha,
    [property: JsonPropertyName("cases")] IReadOnlyList<BodyweightCaseDto> Cases);

internal sealed record BodyweightCaseDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("readings")] IReadOnlyList<BodyweightReadingDto> Readings);

internal sealed record BodyweightReadingDto(
    [property: JsonPropertyName("on")] string On,
    [property: JsonPropertyName("lb")] double Lb);

internal sealed record BodyweightExpectedFile(
    [property: JsonPropertyName("emaAlpha")] double EmaAlpha,
    [property: JsonPropertyName("decimals")] int Decimals,
    [property: JsonPropertyName("expected")] IReadOnlyDictionary<string, double> Expected);
