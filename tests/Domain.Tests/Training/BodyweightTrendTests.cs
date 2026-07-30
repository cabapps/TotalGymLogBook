using TotalGymLogBook.Domain.Training;
using Xunit;

namespace TotalGymLogBook.Domain.Tests.Training;

public class BodyweightTrendTests
{
    private static readonly DateOnly Start = new(2026, 1, 1);

    /// <summary>Daily readings falling at a steady rate, with realistic day-to-day noise.</summary>
    private static BodyweightTrend Series(double startLb, double perWeek, int days, double noise = 0)
    {
        var rng = new Random(42);
        var readings = Enumerable.Range(0, days).Select(d => new BodyweightReading(
            Start.AddDays(d),
            startLb + perWeek * d / 7.0 + (noise == 0 ? 0 : (rng.NextDouble() - 0.5) * 2 * noise)));
        return new BodyweightTrend(readings);
    }

    [Fact]
    public void NoReadings_IsUnknown()
    {
        var trend = new BodyweightTrend([]);
        Assert.Equal(EnergyBalance.Unknown, trend.InferPhase(Start).Balance);
        Assert.Null(trend.SmoothedLb);
    }

    [Fact]
    public void TooFewReadings_StaysUnknown()
    {
        // Confidently wrong is worse than silent: two weigh-ins cannot establish a trend.
        var trend = new BodyweightTrend([
            new BodyweightReading(Start, 200),
            new BodyweightReading(Start.AddDays(20), 190)
        ]);

        Assert.Equal(EnergyBalance.Unknown, trend.InferPhase(Start.AddDays(20)).Balance);
    }

    [Fact]
    public void TooShortASpan_StaysUnknown()
    {
        // Plenty of readings, but only across four days.
        var trend = Series(200, -2.0, days: 4);
        Assert.Equal(EnergyBalance.Unknown, trend.InferPhase(Start.AddDays(3)).Balance);
    }

    [Theory]
    [InlineData(-1.5, EnergyBalance.Deficit)]
    [InlineData(-0.5, EnergyBalance.Deficit)]
    [InlineData(0.0, EnergyBalance.Maintenance)]
    [InlineData(0.5, EnergyBalance.Surplus)]
    [InlineData(1.5, EnergyBalance.Surplus)]
    public void InfersPhaseFromRate(double perWeek, EnergyBalance expected)
    {
        var trend = Series(200, perWeek, days: 28);
        var phase = trend.InferPhase(Start.AddDays(27));

        Assert.Equal(expected, phase.Balance);
        Assert.Equal(perWeek, phase.RateLbPerWeek, 1);
    }

    [Fact]
    public void Hysteresis_KeepsAPhaseThroughAWobble()
    {
        // Losing 0.15 lb/wk: past the exit threshold (0.10) but short of entry (0.25).
        var wobbling = Series(200, -0.15, days: 28);
        var asOf = Start.AddDays(27);

        // Coming from a deficit, stay in it.
        Assert.Equal(EnergyBalance.Deficit,
            wobbling.InferPhase(asOf, previous: EnergyBalance.Deficit).Balance);

        // Coming from maintenance, do not enter one.
        Assert.Equal(EnergyBalance.Maintenance,
            wobbling.InferPhase(asOf, previous: EnergyBalance.Maintenance).Balance);
    }

    [Fact]
    public void Hysteresis_ReleasesOnceTheTrendClearlyReverses()
    {
        var flat = Series(200, 0.0, days: 28);
        Assert.Equal(EnergyBalance.Maintenance,
            flat.InferPhase(Start.AddDays(27), previous: EnergyBalance.Deficit).Balance);
    }

    [Fact]
    public void Smoothing_SurvivesDailyWaterWeightSwings()
    {
        // Genuinely flat weight with +/- 3 lb of daily noise. The whole point of smoothing is
        // that a Tuesday bloat must not rewrite the user's resistance numbers.
        var noisy = Series(200, 0.0, days: 30, noise: 3.0);

        Assert.InRange(noisy.SmoothedLb!.Value, 198.5, 201.5);
        Assert.Equal(EnergyBalance.Maintenance, noisy.InferPhase(Start.AddDays(29)).Balance);
    }

    [Fact]
    public void Rate_IsRobustToNoiseOnARealCut()
    {
        // A believable cut: 1 lb/wk with 3 lb of daily noise on top.
        var cutting = Series(220, -1.0, days: 28, noise: 3.0);
        var phase = cutting.InferPhase(Start.AddDays(27));

        Assert.Equal(EnergyBalance.Deficit, phase.Balance);
        Assert.InRange(phase.RateLbPerWeek, -1.6, -0.4);
    }

    [Fact]
    public void StaleReadings_AreFlagged()
    {
        var trend = Series(200, -1.0, days: 28);

        Assert.False(trend.InferPhase(Start.AddDays(27)).IsStale);
        // A bodyweight three months old silently corrupts every load figure computed from it.
        Assert.True(trend.InferPhase(Start.AddDays(120)).IsStale);
    }

    [Fact]
    public void OnlyLooksAtTheTrailingWindow()
    {
        // Lost a lot early, then held steady for a month. The current phase is maintenance.
        var readings = Enumerable.Range(0, 30).Select(d => new BodyweightReading(Start.AddDays(d), 220 - d * 0.5))
            .Concat(Enumerable.Range(0, 30).Select(d => new BodyweightReading(Start.AddDays(30 + d), 205)));

        var trend = new BodyweightTrend(readings);
        Assert.Equal(EnergyBalance.Maintenance, trend.InferPhase(Start.AddDays(59)).Balance);
    }

    /// <summary>
    /// The regression guard for the reason <see cref="BodyweightTrend.MinRateSignificance"/>
    /// exists. Judged on a fixed rate threshold alone, daily +/- 3 lb noise on a genuinely
    /// stable weight puts the fitted slope's standard error at ~0.26 lb/week -- the same size
    /// as the 0.25 entry threshold -- so a third of weight-stable users would be handed a
    /// phase, and hysteresis would then hold them in it.
    /// </summary>
    [Fact]
    public void StableWeight_IsRarelyMisreadAsAPhase()
    {
        var (falsePositive, _) = SimulatePhaseDetection(trueRatePerWeek: 0.0);

        // Measured ~6% at MinRateSignificance = 2.0. Was 33% before significance gating.
        Assert.True(falsePositive < 0.12,
            $"{falsePositive:P1} of weight-stable users were assigned a phase; expected well "
            + "under 12%. Check MinRateSignificance.");
    }

    /// <summary>The flip side: tightening against noise must not blind the coach to a real cut.
    /// Missing one is the worse error, because the compensation rule then never fires and the
    /// user watches their numbers fall with no explanation.</summary>
    [Fact]
    public void RealWeightLoss_IsStillDetectedThroughNoise()
    {
        var (_, detected) = SimulatePhaseDetection(trueRatePerWeek: -1.0);

        // Measured ~95% over a 28-day window at MinRateSignificance = 2.0.
        Assert.True(detected > 0.90, $"only {detected:P1} of real 1 lb/week cuts were detected.");
    }

    /// <summary>
    /// Runs the inference over many synthetic 28-day series with realistic +/- 3 lb daily noise.
    /// Returns (fraction assigned any phase, fraction correctly called a deficit).
    /// </summary>
    private static (double AnyPhase, double Deficit) SimulatePhaseDetection(
        double trueRatePerWeek, int trials = 1000)
    {
        var rng = new Random(7);
        int anyPhase = 0, deficit = 0;

        for (var t = 0; t < trials; t++)
        {
            var readings = Enumerable.Range(0, BodyweightTrend.TrendWindowDays)
                .Select(d => new BodyweightReading(
                    Start.AddDays(d),
                    200 + trueRatePerWeek * d / 7.0 + (rng.NextDouble() - 0.5) * 6.0))
                .ToList();

            var balance = new BodyweightTrend(readings)
                .InferPhase(Start.AddDays(BodyweightTrend.TrendWindowDays - 1)).Balance;

            if (balance is EnergyBalance.Deficit or EnergyBalance.Surplus) anyPhase++;
            if (balance == EnergyBalance.Deficit) deficit++;
        }

        return ((double)anyPhase / trials, (double)deficit / trials);
    }

    [Fact]
    public void WeighingInMoreOften_SharpensDetection()
    {
        // Same underlying trend and noise; the sparse series simply cannot support a call.
        var rng = new Random(11);
        double Noise() => (rng.NextDouble() - 0.5) * 6.0;

        var daily = new BodyweightTrend(Enumerable.Range(0, 28)
            .Select(d => new BodyweightReading(Start.AddDays(d), 210 - 0.4 * d / 7.0 + Noise())));
        var weekly = new BodyweightTrend(Enumerable.Range(0, 4)
            .Select(w => new BodyweightReading(Start.AddDays(w * 7), 210 - 0.4 * w + Noise())));

        Assert.True(daily.RateStandardError(Start.AddDays(27))
                    < weekly.RateStandardError(Start.AddDays(21)));
    }

    [Fact]
    public void Describe_NeverNamesThePhase()
    {
        // docs/adr/0010: the phase is an internal enum. The UI reports what was observed.
        var jargon = new[] { "deficit", "surplus", "phase", "maintenance", "energy balance" };

        foreach (var rate in new[] { -1.0, 0.0, 1.0 })
        {
            var text = Series(200, rate, days: 28).Describe(Start.AddDays(27)).ToLowerInvariant();
            foreach (var word in jargon)
            {
                Assert.DoesNotContain(word, text);
            }
        }
    }

    [Fact]
    public void Describe_ExplainsWhyLiftsMayLookWorseWhenCutting()
    {
        var text = Series(200, -1.0, days: 28).Describe(Start.AddDays(27));
        Assert.Contains("losing fat", text);
        Assert.Contains("keep your lifts", text);
    }

    [Fact]
    public void Describe_ExplainsThatBulkingInflatesLoad()
    {
        var text = Series(200, 1.0, days: 28).Describe(Start.AddDays(27));
        Assert.Contains("rather than extra strength", text);
    }
}
