using TotalGymLogBook.Domain.Persistence;
using TotalGymLogBook.Domain.Training;
using Xunit;

namespace TotalGymLogBook.Domain.Tests.Persistence;

/// <summary>
/// The interop boundary's testable half. Interop itself targets browser-wasm and holds no
/// logic; everything that can actually be wrong -- JSON shapes, tombstones, null payloads,
/// bad dates -- is exercised here on the desktop runtime.
///
/// The JSON literals below are the shapes src/client/src/db/schema.ts actually writes. If
/// either side renames a field, these fail.
/// </summary>
public class LogbookMapperTests
{
    private const string OneSetJson = """
    [{
      "id": "a1", "sessionId": "s1", "exerciseId": "chest-press",
      "ts": 1772409600000, "on": "2026-03-01",
      "reps": 12, "level": 8,
      "bodyweightRawLb": 181.2, "bodyweightSmoothedLb": 180,
      "angleDeg": 16.5, "boardWeightLb": 19.8,
      "pulleyFactor": 1, "bodyFraction": 1,
      "vestLb": 0, "barLb": 0, "directLoadLb": 0,
      "computedLb": 56.7, "formulaVersion": 1,
      "updatedAt": 1772409600000
    }]
    """;

    // ---------------------------------------------------------------- parsing

    [Fact]
    public void ParsesTheShapeTypeScriptActuallyWrites()
    {
        var sets = LogbookMapper.ParseSetLogs(OneSetJson);

        Assert.Single(sets);
        var set = sets[0];
        Assert.Equal("chest-press", set.ExerciseId);
        Assert.Equal(12, set.Reps);
        Assert.Equal(8, set.Level);
        Assert.Equal(56.7, set.ComputedLb);
        Assert.Equal(19.8, set.BoardWeightLb);
        Assert.Equal(1, set.FormulaVersion);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("null")]
    [InlineData("[]")]
    public void EmptyAndNullPayloadsYieldAnEmptyList(string? json)
    {
        // The bridge returns "null" for an absent record. On the boot path this must not throw.
        Assert.Empty(LogbookMapper.ParseSetLogs(json));
    }

    [Fact]
    public void CorruptJsonDegradesToEmptyRatherThanCrashingTheApp()
    {
        // Better an empty chart than a white screen; the raw data is still recoverable
        // through export.
        Assert.Empty(LogbookMapper.ParseSetLogs("{ this is not json"));
        Assert.Empty(LogbookMapper.ParseBodyweight("]["));
    }

    [Fact]
    public void ParseSettingsReturnsDefaultsRatherThanNull()
    {
        var settings = LogbookMapper.ParseSettings("null");

        Assert.NotNull(settings);
        Assert.Null(settings.GoalPrimary);
    }

    [Fact]
    public void ParseSessionHandlesTheAbsentCase()
    {
        Assert.Null(LogbookMapper.ParseSession("null"));
        Assert.NotNull(LogbookMapper.ParseSession(
            """{"id":"s1","startedAt":1,"status":"active","machineId":"m1"}"""));
    }

    // ---------------------------------------------------------------- to domain

    [Fact]
    public void MapsASetLogToTheDomainRecord()
    {
        var history = LogbookMapper.ToExerciseHistory(
            "chest-press", LogbookMapper.ParseSetLogs(OneSetJson));

        var set = Assert.Single(history.Sets);
        Assert.Equal(12, set.Reps);
        Assert.Equal(56.7, set.ComputedLb);
        Assert.Equal(new DateOnly(2026, 3, 1), set.On);
    }

    /// <summary>
    /// Regression guard. The workout date must come from the stored local `on` field, not from
    /// re-deriving a UTC date out of `ts` -- otherwise an 8pm session in the Americas gets
    /// filed under tomorrow, splitting one workout across two dates and shifting it out of the
    /// volume ledger's trailing window.
    /// </summary>
    [Fact]
    public void UsesTheStoredLocalDateRatherThanTheUtcDateOfTheTimestamp()
    {
        // 8pm on 1 March in a UTC-5 zone: the instant is already 2 March in UTC.
        const string eveningWorkout = """
        [{"id":"a","sessionId":"s","exerciseId":"e","ts":1772499600000,"on":"2026-03-01",
          "reps":10,"level":8,"computedLb":50,"formulaVersion":1,"updatedAt":1}]
        """;

        var history = LogbookMapper.ToExerciseHistory("e", LogbookMapper.ParseSetLogs(eveningWorkout));

        Assert.Equal(new DateOnly(2026, 3, 1), history.Sets[0].On);
    }

    [Fact]
    public void TombstonedSetsNeverReachTheDomain()
    {
        // Second gate: the repository filters these too, but a stale backup import could
        // land one here.
        const string withTombstone = """
        [
          {"id":"a","sessionId":"s","exerciseId":"e","ts":1772409600000,"on":"2026-03-01",
           "reps":10,"level":8,"computedLb":50,"formulaVersion":1,"updatedAt":1},
          {"id":"b","sessionId":"s","exerciseId":"e","ts":1772409600000,"on":"2026-03-01",
           "reps":99,"level":8,"computedLb":50,"formulaVersion":1,"updatedAt":1,"deletedAt":2}
        ]
        """;

        var history = LogbookMapper.ToExerciseHistory("e", LogbookMapper.ParseSetLogs(withTombstone));

        Assert.Single(history.Sets);
        Assert.Equal(10, history.Sets[0].Reps);
    }

    [Fact]
    public void OrdersSetsChronologicallyRegardlessOfStorageOrder()
    {
        const string outOfOrder = """
        [
          {"id":"c","sessionId":"s","exerciseId":"e","ts":3000000000000,"on":"2065-01-24",
           "reps":3,"level":8,"computedLb":50,"formulaVersion":1,"updatedAt":1},
          {"id":"a","sessionId":"s","exerciseId":"e","ts":1000000000000,"on":"2001-09-09",
           "reps":1,"level":8,"computedLb":50,"formulaVersion":1,"updatedAt":1},
          {"id":"b","sessionId":"s","exerciseId":"e","ts":2000000000000,"on":"2033-05-18",
           "reps":2,"level":8,"computedLb":50,"formulaVersion":1,"updatedAt":1}
        ]
        """;

        var history = LogbookMapper.ToExerciseHistory("e", LogbookMapper.ParseSetLogs(outOfOrder));

        Assert.Equal([1, 2, 3], history.Sets.Select(s => s.Reps));
    }

    [Fact]
    public void GroupsAFlatSetListByExerciseForTheVolumeLedger()
    {
        const string mixed = """
        [
          {"id":"1","sessionId":"s","exerciseId":"chest-press","ts":1772409600000,"on":"2026-03-01",
           "reps":10,"level":8,"computedLb":50,"formulaVersion":1,"updatedAt":1},
          {"id":"2","sessionId":"s","exerciseId":"seated-row","ts":1772409600000,"on":"2026-03-01",
           "reps":10,"level":8,"computedLb":40,"formulaVersion":1,"updatedAt":1},
          {"id":"3","sessionId":"s","exerciseId":"chest-press","ts":1772496000000,"on":"2026-03-02",
           "reps":11,"level":8,"computedLb":50,"formulaVersion":1,"updatedAt":1}
        ]
        """;

        var grouped = LogbookMapper.GroupByExercise(LogbookMapper.ParseSetLogs(mixed));

        Assert.Equal(2, grouped.Count);
        Assert.Equal(2, grouped.Single(h => h.ExerciseId == "chest-press").Sets.Count);
        Assert.Single(grouped.Single(h => h.ExerciseId == "seated-row").Sets);
    }

    // ---------------------------------------------------------------- bodyweight

    [Fact]
    public void BuildsABodyweightTrendFromStoredReadings()
    {
        const string json = """
        [
          {"id":"1","on":"2026-03-01","lb":200,"updatedAt":1},
          {"id":"2","on":"2026-03-08","lb":199,"updatedAt":1},
          {"id":"3","on":"2026-03-15","lb":198,"updatedAt":1},
          {"id":"4","on":"2026-03-22","lb":197,"updatedAt":1}
        ]
        """;

        var trend = LogbookMapper.ToBodyweightTrend(LogbookMapper.ParseBodyweight(json));

        Assert.True(trend.HasAny);
        Assert.Equal(new DateOnly(2026, 3, 22), trend.Latest!.On);
        Assert.Equal(EnergyBalance.Deficit, trend.InferPhase(new DateOnly(2026, 3, 22)).Balance);
    }

    [Fact]
    public void SkipsDeletedAndUnparseableReadingsInsteadOfThrowing()
    {
        const string json = """
        [
          {"id":"1","on":"2026-03-01","lb":200,"updatedAt":1},
          {"id":"2","on":"2026-03-08","lb":190,"updatedAt":1,"deletedAt":5},
          {"id":"3","on":"not-a-date","lb":180,"updatedAt":1}
        ]
        """;

        var trend = LogbookMapper.ToBodyweightTrend(LogbookMapper.ParseBodyweight(json));

        Assert.Equal(200, trend.Latest!.Lb);
    }

    // ---------------------------------------------------------------- histories

    [Fact]
    public void ParsesTheGroupedHistoriesShapeFromTheBridge()
    {
        const string json = """
        [{
          "exerciseId": "chest-press",
          "sets": [
            {"id":"1","sessionId":"s","exerciseId":"chest-press","ts":1772409600000,
             "on":"2026-03-01","reps":12,"level":8,"computedLb":56.7,"formulaVersion":1,"updatedAt":1}
          ]
        }]
        """;

        var histories = LogbookMapper.ToExerciseHistories(LogbookMapper.ParseHistories(json));

        var history = Assert.Single(histories);
        Assert.Equal("chest-press", history.ExerciseId);
        Assert.Equal(56.7, history.Sets[0].ComputedLb);
    }

    /// <summary>
    /// The end-to-end shape check: stored JSON in, a coaching recommendation out, with no
    /// hand-built domain objects anywhere in between.
    /// </summary>
    [Fact]
    public void StoredJsonFlowsAllTheWayToARecommendation()
    {
        var profiles = RepoData.Profiles();
        var history = LogbookMapper.ToExerciseHistory(
            "chest-press", LogbookMapper.ParseSetLogs(OneSetJson));

        var ladder = new LoadLadder(profiles["rail-14"], 180, EquipmentInventory.None);
        var rec = new ProgressionEngine().NextSession(
            history, new TrainingGoal(GoalType.Hypertrophy),
            new Phase(EnergyBalance.Maintenance, 0, false), ladder);

        // Logged 12 reps at 56.7 lb (level 8), so the coach steps to level 9.
        Assert.Equal(ProgressionLever.IncreaseLevel, rec.Lever);
        Assert.Equal(9, rec.Level);
        Assert.Equal(8, rec.TargetReps);
    }
}
