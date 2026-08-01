using System.Text.Json;
using TotalGymLogBook.Domain.Training;

namespace TotalGymLogBook.Domain.Persistence;

/// <summary>
/// Turns stored JSON into the types the coach reasons about.
///
/// Pure and dependency-free, so every edge case here is covered by desktop unit tests rather
/// than discovered in a browser: null JSON, tombstoned rows, empty arrays, an unparseable
/// date. Interop calls into this and holds no logic of its own.
/// </summary>
public static class LogbookMapper
{
    /// <summary>Tombstoned rows never reach the domain. The repository filters them too; this
    /// is the second gate, because a stale backup import could land one here.</summary>
    private static bool IsLive(SetLogDto dto) => dto.DeletedAt is null;

    public static IReadOnlyList<SetLogDto> ParseSetLogs(string? json) =>
        Deserialize(json, LogbookJson.Default.IReadOnlyListSetLogDto);

    public static IReadOnlyList<ExerciseHistoryDto> ParseHistories(string? json) =>
        Deserialize(json, LogbookJson.Default.IReadOnlyListExerciseHistoryDto);

    public static IReadOnlyList<BodyweightDto> ParseBodyweight(string? json) =>
        Deserialize(json, LogbookJson.Default.IReadOnlyListBodyweightDto);

    public static IReadOnlyList<SessionDto> ParseSessions(string? json) =>
        Deserialize(json, LogbookJson.Default.IReadOnlyListSessionDto);

    public static IReadOnlyList<SessionWithSetsDto> ParseSessionHistory(string? json) =>
        Deserialize(json, LogbookJson.Default.IReadOnlyListSessionWithSetsDto);

    public static IReadOnlyList<MachineDto> ParseMachines(string? json) =>
        Deserialize(json, LogbookJson.Default.IReadOnlyListMachineDto);

    public static SettingsDto ParseSettings(string? json) =>
        string.IsNullOrWhiteSpace(json) || json == "null"
            ? new SettingsDto()
            : JsonSerializer.Deserialize(json, LogbookJson.Default.SettingsDto) ?? new SettingsDto();

    public static SessionDto? ParseSession(string? json) =>
        string.IsNullOrWhiteSpace(json) || json == "null"
            ? null
            : JsonSerializer.Deserialize(json, LogbookJson.Default.SessionDto);

    // ------------------------------------------------------------------ to domain

    /// <summary>
    /// Uses the stored <c>on</c> field rather than deriving a date from <c>ts</c>.
    ///
    /// `on` is the LOCAL calendar date the trainee was actually in when they logged the set;
    /// `ts` is an instant. Re-deriving from the instant here would reintroduce a UTC date and
    /// file an 8pm workout in the Americas under the following day. "Which day did I train?"
    /// is a local-calendar question, and the client already answered it.
    ///
    /// Falls back to the instant only if `on` is missing or malformed, which should not happen
    /// for rows this app wrote.
    /// </summary>
    public static SetRecord ToSetRecord(SetLogDto dto) => new(
        On: TryParseIsoDate(dto.On, out var on)
            ? on
            : DateOnly.FromDateTime(DateTimeOffset.FromUnixTimeMilliseconds(dto.Ts).UtcDateTime),
        Reps: dto.Reps,
        ComputedLb: dto.ComputedLb,
        Level: dto.Level,
        VestLb: dto.VestLb,
        BarLb: dto.BarLb,
        // Carried through so the coach can rebuild the ladder for the RIGHT exercise. Older
        // rows written before these were snapshotted default to 1.0, which is the direct case.
        PulleyFactor: dto.PulleyFactor == 0 ? 1.0 : dto.PulleyFactor,
        BodyFraction: dto.BodyFraction == 0 ? 1.0 : dto.BodyFraction);

    public static ExerciseHistory ToExerciseHistory(string exerciseId, IEnumerable<SetLogDto> sets) =>
        new(exerciseId, sets.Where(IsLive).OrderBy(s => s.Ts).Select(ToSetRecord).ToList());

    public static ExerciseHistory ToExerciseHistory(ExerciseHistoryDto dto) =>
        ToExerciseHistory(dto.ExerciseId, dto.Sets);

    public static IReadOnlyList<ExerciseHistory> ToExerciseHistories(
        IEnumerable<ExerciseHistoryDto> dtos) =>
        dtos.Select(ToExerciseHistory).ToList();

    public static BodyweightReading ToBodyweightReading(BodyweightDto dto) =>
        new(ParseIsoDate(dto.On), dto.Lb);

    public static BodyweightTrend ToBodyweightTrend(IEnumerable<BodyweightDto> dtos) =>
        new(dtos.Where(d => d.DeletedAt is null && TryParseIsoDate(d.On, out _))
                .Select(ToBodyweightReading));

    /// <summary>
    /// Groups a flat set list by exercise. Used for the volume ledger, which needs every
    /// exercise at once rather than one at a time.
    /// </summary>
    public static IReadOnlyList<ExerciseHistory> GroupByExercise(IEnumerable<SetLogDto> sets) =>
        sets.Where(IsLive)
            .GroupBy(s => s.ExerciseId)
            .Select(g => ToExerciseHistory(g.Key, g))
            .ToList();

    // ------------------------------------------------------------------ helpers

    private static IReadOnlyList<T> Deserialize<T>(
        string? json, System.Text.Json.Serialization.Metadata.JsonTypeInfo<IReadOnlyList<T>> info)
    {
        // The bridge returns "null" for an absent record rather than failing, and an empty
        // store yields "[]". Both must produce an empty list, not a crash on the boot path.
        if (string.IsNullOrWhiteSpace(json) || json == "null") return [];

        try
        {
            return JsonSerializer.Deserialize(json, info) ?? [];
        }
        catch (JsonException)
        {
            // A corrupt row must not take down the whole app. Better an empty chart than a
            // white screen; the raw data is still recoverable via export.
            return [];
        }
    }

    private static DateOnly ParseIsoDate(string value) =>
        TryParseIsoDate(value, out var date)
            ? date
            : throw new FormatException($"'{value}' is not a YYYY-MM-DD date.");

    private static bool TryParseIsoDate(string value, out DateOnly date) =>
        DateOnly.TryParseExact(value, "yyyy-MM-dd", null,
            System.Globalization.DateTimeStyles.None, out date);
}
