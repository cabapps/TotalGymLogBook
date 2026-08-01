using System.Runtime.Versioning;
using TotalGymLogBook.Domain;
using TotalGymLogBook.Domain.Persistence;
using TotalGymLogBook.Domain.Training;

namespace TotalGymLogBook.Interop;

/// <summary>
/// What Blazor components inject. Reads through the TypeScript bridge and hands back domain
/// types, so nothing above this line ever sees a DTO or a JSON string.
///
/// Caching matters here. docs/adr/0003 rule 2 says the change bus carries ids and consumers
/// re-read -- but re-reading on every render would cross the interop boundary dozens of times
/// per frame. So this caches per store and invalidates on the change event, which is the point
/// of subscribing rather than polling.
/// </summary>
[SupportedOSPlatform("browser")]
public sealed class Logbook
{
    private readonly RailProfileTable _profiles;

    private IReadOnlyList<ExerciseHistory>? _histories;
    private BodyweightTrend? _trend;
    private bool _subscribed;

    public Logbook(RailProfileTable profiles) => _profiles = profiles;

    /// <summary>Raised after the underlying data changes, so components can re-render.</summary>
    public event Action? Changed;

    public async Task InitializeAsync()
    {
        await DbBridge.EnsureImportedAsync();

        if (_subscribed) return;
        DbBridge.SubscribeToChanges(OnStoreChanged);
        _subscribed = true;
    }

    private void OnStoreChanged(string store, string _)
    {
        // Drop the affected cache and let components re-read lazily. Deliberately does not
        // fetch here: a burst of set logs would otherwise trigger a fetch per set.
        switch (store)
        {
            case "setLogs":
                _histories = null;
                break;
            case "bodyweight":
                _trend = null;
                break;
            case "focus":
                // The trainee changed the exercise dropdown. Nothing in the logbook moved, so
                // dropping the caches here would refetch the entire history on every flick
                // through the selector.
                break;
            default:
                _histories = null;
                _trend = null;
                break;
        }

        Changed?.Invoke();
    }

    // ------------------------------------------------------------------ reads

    public async Task<ExerciseHistory> GetExerciseHistoryAsync(string exerciseId, int days = 365)
    {
        await DbBridge.EnsureImportedAsync();

        var since = DateTimeOffset.UtcNow.AddDays(-days).ToUnixTimeMilliseconds();
        var json = await DbBridge.GetExerciseHistoryJson(exerciseId, since);

        return LogbookMapper.ToExerciseHistory(exerciseId, LogbookMapper.ParseSetLogs(json));
    }

    public async Task<IReadOnlyList<ExerciseHistory>> GetHistoriesAsync(int days = 90)
    {
        if (_histories is not null) return _histories;

        await DbBridge.EnsureImportedAsync();
        var json = await DbBridge.GetHistoriesJson(days);

        return _histories = LogbookMapper.ToExerciseHistories(LogbookMapper.ParseHistories(json));
    }

    public async Task<BodyweightTrend> GetBodyweightTrendAsync()
    {
        if (_trend is not null) return _trend;

        await DbBridge.EnsureImportedAsync();
        var json = await DbBridge.GetBodyweightReadingsJson(null);

        return _trend = LogbookMapper.ToBodyweightTrend(LogbookMapper.ParseBodyweight(json));
    }

    public async Task<SessionDto?> GetActiveSessionAsync()
    {
        await DbBridge.EnsureImportedAsync();
        return LogbookMapper.ParseSession(await DbBridge.GetActiveSessionJson());
    }

    /// <summary>
    /// The exercise the trainee has selected in the logger -- what they are ABOUT to do, which
    /// is what the coach needs to advise on. Synchronous and uncached: it is one field of
    /// in-memory shell state, not a database read (see src/client/src/focus.ts).
    /// </summary>
    public string GetFocusedExerciseId()
    {
        var json = DbBridge.GetFocusJson();
        return LogbookMapper.ParseFocusExerciseId(json);
    }

    /// <summary>The program the trainee is following, or null. Uncached: it is one small row.</summary>
    public async Task<TrainingProgram?> GetActiveProgramAsync()
    {
        await DbBridge.EnsureImportedAsync();

        var dto = LogbookMapper.ParseProgram(await DbBridge.GetActiveProgramJson());
        return dto is null ? null : LogbookMapper.ToProgram(dto);
    }

    public async Task<SettingsDto> GetSettingsAsync()
    {
        await DbBridge.EnsureImportedAsync();
        return LogbookMapper.ParseSettings(await DbBridge.GetSettingsJson());
    }

    public async Task<IReadOnlyList<MachineDto>> GetMachinesAsync()
    {
        await DbBridge.EnsureImportedAsync();
        return LogbookMapper.ParseMachines(await DbBridge.ListMachinesJson());
    }

    public async Task<IReadOnlyList<SessionWithSetsDto>> GetSessionHistoryAsync(int days = 365)
    {
        await DbBridge.EnsureImportedAsync();
        return LogbookMapper.ParseSessionHistory(await DbBridge.GetSessionHistoryJson(days));
    }

    /// <summary>Soft-deletes a session and its sets, then invalidates the caches.</summary>
    public async Task DeleteSessionAsync(string sessionId)
    {
        await DbBridge.EnsureImportedAsync();
        await DbBridge.DeleteSessionJson(sessionId);
        _histories = null;
    }

    /// <summary>
    /// Clears sessions opened but never used. Earlier builds created a session on every app
    /// open, so existing logbooks are full of empties even though sessions are lazy now.
    /// </summary>
    public async Task<int> PurgeEmptySessionsAsync()
    {
        await DbBridge.EnsureImportedAsync();
        var json = await DbBridge.PurgeEmptySessionsJson();
        _histories = null;

        using var doc = System.Text.Json.JsonDocument.Parse(json);
        return doc.RootElement.TryGetProperty("purged", out var p) ? p.GetInt32() : 0;
    }

    // ------------------------------------------------------------------ derived

    /// <summary>
    /// The trainee's current phase, inferred from the scale rather than asked (docs/adr/0010).
    /// Honors the advanced override when one is pinned.
    /// </summary>
    public async Task<Phase> GetPhaseAsync(DateOnly asOf)
    {
        var settings = await GetSettingsAsync();

        if (!string.IsNullOrWhiteSpace(settings.PhaseOverride)
            && settings.PhaseOverride != "auto"
            && Enum.TryParse<EnergyBalance>(settings.PhaseOverride, true, out var pinned))
        {
            return new Phase(pinned, 0, false);
        }

        return (await GetBodyweightTrendAsync()).InferPhase(asOf);
    }

    /// <summary>
    /// Training age, inferred from history the same way phase is (docs/adr/0010): someone with
    /// three weeks of logs is a novice whatever they would claim. Honors the advanced
    /// override.
    ///
    /// The thresholds are session counts rather than calendar time, because someone who trained
    /// twice a month for a year is not an intermediate.
    /// </summary>
    public async Task<ExperienceLevel> GetExperienceAsync()
    {
        var settings = await GetSettingsAsync();

        if (!string.IsNullOrWhiteSpace(settings.ExperienceOverride)
            && settings.ExperienceOverride != "auto"
            && Enum.TryParse<ExperienceLevel>(settings.ExperienceOverride, true, out var pinned))
        {
            return pinned;
        }

        var histories = await GetHistoriesAsync();
        var sessions = histories
            .SelectMany(h => h.Sets.Select(s => s.On))
            .Distinct()
            .Count();

        return sessions switch
        {
            < 24 => ExperienceLevel.Novice,
            < 100 => ExperienceLevel.Intermediate,
            _ => ExperienceLevel.Advanced
        };
    }

    public async Task<TrainingGoal> GetGoalAsync()
    {
        var settings = await GetSettingsAsync();

        var primary = Enum.TryParse<GoalType>(settings.GoalPrimary, true, out var p)
            ? p
            : GoalType.Hypertrophy;

        GoalType? secondary = Enum.TryParse<GoalType>(settings.GoalSecondary, true, out var s)
            ? s
            : null;

        return new TrainingGoal(primary, secondary);
    }

    /// <summary>
    /// The trainee's machine, honoring any inclinometer calibration. Falls back to the
    /// 14-notch profile so the app is usable before onboarding completes.
    /// </summary>
    public async Task<RailProfile> GetRailProfileAsync()
    {
        var machines = await GetMachinesAsync();
        var machine = machines.FirstOrDefault(m => m.IsDefault == true) ?? machines.FirstOrDefault();

        if (machine is null || !_profiles.TryGet(machine.RailProfileId, out var profile) || profile is null)
        {
            return _profiles.ForLevelCount(14);
        }

        if (machine.CalibratedAngleDeg is { Length: > 0 } calibrated
            && calibrated.Length == profile.LevelCount)
        {
            return profile with { AngleDeg = calibrated, AngleSource = AngleSource.Calibrated };
        }

        return profile;
    }
}
