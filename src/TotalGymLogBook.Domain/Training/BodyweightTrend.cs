namespace TotalGymLogBook.Domain.Training;

public sealed record BodyweightReading(DateOnly On, double Lb);

/// <summary>What the body is DOING. Inferred from the scale, never asked. See docs/adr/0010.</summary>
public enum EnergyBalance
{
    /// <summary>Not enough weigh-ins to say. The coach must stay neutral here: confidently
    /// wrong is far worse than silent.</summary>
    Unknown,
    Deficit,
    Maintenance,
    Surplus
}

public sealed record Phase(EnergyBalance Balance, double RateLbPerWeek, bool IsStale)
{
    public static readonly Phase Unknown = new(EnergyBalance.Unknown, 0, false);
}

/// <summary>
/// Turns a series of weigh-ins into (a) a smoothed weight for the resistance calculation and
/// (b) an inferred training phase.
///
/// Two things make this trustworthy rather than jittery:
///
///   Smoothing. Daily weight swings 2-4 lb on water and glycogen alone. An EMA feeds the load
///   calculation so a Tuesday bloat does not rewrite the user's numbers.
///
///   Hysteresis. Entry and exit thresholds differ, so a trend wobbling across a single
///   boundary cannot flip the coach's advice week to week. Same debounce thinking as the rep
///   detector in docs/adr/0006, on a much slower signal.
/// </summary>
public sealed class BodyweightTrend
{
    // Enter a phase decisively; leave it reluctantly. The gap between these is the hysteresis.
    public const double EnterRateLbPerWeek = 0.25;
    public const double ExitRateLbPerWeek = 0.10;

    /// <summary>
    /// A fixed rate threshold is not enough on its own. Daily weight noise of +/- 3 lb over 30
    /// readings puts the standard error of the fitted slope at ~0.26 lb/week -- indistinguishable
    /// from the entry threshold. Measured by simulation, a genuinely WEIGHT-STABLE user would be
    /// assigned a phase 33% of the time, and hysteresis then makes it worse by holding them
    /// there.
    ///
    /// So a phase also has to be statistically distinguishable from flat: the fitted rate must
    /// exceed this many standard errors. At 2.0 the false-positive rate drops to ~4%, while a
    /// real 1 lb/week cut is still detected comfortably (its rate is ~4 standard errors out).
    ///
    /// Pleasant side effect: a user who weighs in more often shrinks the standard error, so
    /// consistency is rewarded with faster, more confident phase detection.
    /// </summary>
    public const double MinRateSignificance = 2.0;

    public const int MinReadings = 3;
    public const int MinSpanDays = 14;
    public const int TrendWindowDays = 28;
    public const int StaleAfterDays = 21;

    /// <summary>Smoothing factor. ~0.25 gives roughly a one-week effective window at daily
    /// weigh-ins, and degrades gracefully when the user weighs in less often.</summary>
    public const double EmaAlpha = 0.25;

    private readonly IReadOnlyList<BodyweightReading> _readings;

    public BodyweightTrend(IEnumerable<BodyweightReading> readings)
    {
        ArgumentNullException.ThrowIfNull(readings);
        _readings = readings.OrderBy(r => r.On).ToList();
    }

    public bool HasAny => _readings.Count > 0;

    /// <summary>The underlying weigh-ins, oldest first. Charting needs the raw series, not
    /// just the derived figures.</summary>
    public IReadOnlyList<BodyweightReading> Readings => _readings;

    public BodyweightReading? Latest => _readings.Count > 0 ? _readings[^1] : null;

    /// <summary>
    /// Exponentially smoothed bodyweight. This is what feeds
    /// <see cref="ResistanceCalculator"/>; the raw reading is stored alongside it on the set
    /// log for auditability (docs/adr/0004).
    /// </summary>
    public double? SmoothedLb
    {
        get
        {
            if (_readings.Count == 0) return null;

            var ema = _readings[0].Lb;
            for (var i = 1; i < _readings.Count; i++)
            {
                ema = EmaAlpha * _readings[i].Lb + (1 - EmaAlpha) * ema;
            }
            return ema;
        }
    }

    /// <summary>
    /// Least-squares slope over the trailing window, in lb/week. A regression rather than an
    /// EMA because phase inference needs a RATE, and differencing a smoothed series amplifies
    /// exactly the noise the smoothing removed.
    /// </summary>
    public double? RateLbPerWeek(DateOnly asOf) => Fit(asOf)?.RateLbPerWeek;

    /// <summary>Standard error of the fitted rate, in lb/week. Small when the user weighs in
    /// often and consistently; large when readings are sparse or noisy.</summary>
    public double? RateStandardError(DateOnly asOf) => Fit(asOf)?.StandardErrorLbPerWeek;

    private sealed record TrendFit(double RateLbPerWeek, double StandardErrorLbPerWeek)
    {
        /// <summary>How many standard errors the rate sits away from flat.</summary>
        public double Significance =>
            StandardErrorLbPerWeek <= 0 ? double.PositiveInfinity
                                        : Math.Abs(RateLbPerWeek) / StandardErrorLbPerWeek;
    }

    private TrendFit? Fit(DateOnly asOf)
    {
        var window = _readings
            .Where(r => r.On > asOf.AddDays(-TrendWindowDays) && r.On <= asOf)
            .ToList();

        if (window.Count < MinReadings) return null;

        var spanDays = window[^1].On.DayNumber - window[0].On.DayNumber;
        if (spanDays < MinSpanDays) return null;

        var meanX = window.Average(r => (double)r.On.DayNumber);
        var meanY = window.Average(r => r.Lb);

        var sxx = window.Sum(r => Math.Pow(r.On.DayNumber - meanX, 2));
        if (sxx == 0) return null;

        var slopePerDay = window.Sum(r => (r.On.DayNumber - meanX) * (r.Lb - meanY)) / sxx;
        var intercept = meanY - slopePerDay * meanX;

        // Residual standard error of the slope. Needs at least 3 points for a spare degree of
        // freedom, which MinReadings already guarantees.
        var sse = window.Sum(r => Math.Pow(r.Lb - (intercept + slopePerDay * r.On.DayNumber), 2));
        var residualVariance = sse / (window.Count - 2);
        var stdErrPerDay = Math.Sqrt(residualVariance / sxx);

        return new TrendFit(slopePerDay * 7.0, stdErrPerDay * 7.0);
    }

    /// <summary>
    /// Infers the phase. <paramref name="previous"/> is last known phase and supplies the
    /// hysteresis; pass <see cref="EnergyBalance.Unknown"/> on a cold start.
    /// </summary>
    public Phase InferPhase(DateOnly asOf, EnergyBalance previous = EnergyBalance.Unknown)
    {
        var stale = Latest is { } l && asOf.DayNumber - l.On.DayNumber > StaleAfterDays;

        if (Fit(asOf) is not { } fit) return Phase.Unknown with { IsStale = stale };

        var r = fit.RateLbPerWeek;

        // Entering a phase requires BOTH a meaningful rate and a rate distinguishable from
        // noise. Leaving only requires the rate to fall back, so a user already known to be
        // cutting is not bounced out by one noisy fortnight.
        var significant = fit.Significance >= MinRateSignificance;

        var balance = previous switch
        {
            EnergyBalance.Deficit when r <= -ExitRateLbPerWeek => EnergyBalance.Deficit,
            EnergyBalance.Surplus when r >= ExitRateLbPerWeek => EnergyBalance.Surplus,

            _ when significant && r <= -EnterRateLbPerWeek => EnergyBalance.Deficit,
            _ when significant && r >= EnterRateLbPerWeek => EnergyBalance.Surplus,
            _ => EnergyBalance.Maintenance
        };

        return new Phase(balance, r, stale);
    }

    /// <summary>
    /// Plain-language description of the trend. The phase is an internal enum and must never
    /// be named to the user; the UI reports what was observed instead. See docs/adr/0010.
    /// </summary>
    public string Describe(DateOnly asOf)
    {
        var phase = InferPhase(asOf);
        if (phase.Balance == EnergyBalance.Unknown)
        {
            return "Weigh in a few times over a couple of weeks and your numbers will sharpen up.";
        }

        var perWeek = Math.Abs(phase.RateLbPerWeek);
        return phase.Balance switch
        {
            EnergyBalance.Deficit =>
                $"You're down about {perWeek:0.#} lb a week. Let's keep your lifts where they "
                + "are — that's how you hold onto muscle while losing fat.",
            EnergyBalance.Surplus =>
                $"You're up about {perWeek:0.#} lb a week, so some of any load increase is the "
                + "extra bodyweight rather than extra strength.",
            _ => "Your weight's been steady, so changes in your lifts are real strength changes."
        };
    }
}
