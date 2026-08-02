using System.Text.Json.Serialization;

namespace TotalGymLogBook.Domain.Persistence;

/// <summary>
/// Wire shapes for the records TypeScript stores in IndexedDB.
///
/// These live in Domain rather than Interop on purpose. Interop targets browser-wasm, and
/// anything referencing it drags tests onto a browser runner (docs/adr/0009). Keeping the DTOs
/// and the mapping here means the fiddly part -- turning stored JSON into domain types -- is
/// unit-testable on the desktop runtime, and Interop shrinks to a handful of [JSImport]
/// declarations with no logic to get wrong.
///
/// Property names match the TypeScript interfaces in src/client/src/db/schema.ts exactly.
/// A rename on either side is a breaking change; the round-trip tests are what catch it.
/// </summary>
public sealed record SetLogDto
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("sessionId")] public string SessionId { get; init; } = "";
    [JsonPropertyName("exerciseId")] public string ExerciseId { get; init; } = "";

    /// <summary>Epoch milliseconds.</summary>
    [JsonPropertyName("ts")] public long Ts { get; init; }

    /// <summary>Calendar date as 'YYYY-MM-DD'.</summary>
    [JsonPropertyName("on")] public string On { get; init; } = "";

    [JsonPropertyName("reps")] public int Reps { get; init; }
    [JsonPropertyName("level")] public int Level { get; init; }

    [JsonPropertyName("bodyweightRawLb")] public double BodyweightRawLb { get; init; }
    [JsonPropertyName("bodyweightSmoothedLb")] public double BodyweightSmoothedLb { get; init; }
    [JsonPropertyName("angleDeg")] public double AngleDeg { get; init; }
    [JsonPropertyName("boardWeightLb")] public double BoardWeightLb { get; init; }
    [JsonPropertyName("pulleyFactor")] public double PulleyFactor { get; init; }
    [JsonPropertyName("bodyFraction")] public double BodyFraction { get; init; }
    [JsonPropertyName("vestLb")] public double VestLb { get; init; }
    [JsonPropertyName("barLb")] public double BarLb { get; init; }
    [JsonPropertyName("directLoadLb")] public double DirectLoadLb { get; init; }

    [JsonPropertyName("computedLb")] public double ComputedLb { get; init; }
    [JsonPropertyName("formulaVersion")] public int FormulaVersion { get; init; }

    [JsonPropertyName("rir")] public int? Rir { get; init; }
    [JsonPropertyName("deletedAt")] public long? DeletedAt { get; init; }
}

public sealed record ExerciseHistoryDto
{
    [JsonPropertyName("exerciseId")] public string ExerciseId { get; init; } = "";
    [JsonPropertyName("sets")] public IReadOnlyList<SetLogDto> Sets { get; init; } = [];
}

public sealed record BodyweightDto
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("on")] public string On { get; init; } = "";
    [JsonPropertyName("lb")] public double Lb { get; init; }
    [JsonPropertyName("deletedAt")] public long? DeletedAt { get; init; }
}

public sealed record SessionDto
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("startedAt")] public long StartedAt { get; init; }
    [JsonPropertyName("endedAt")] public long? EndedAt { get; init; }
    [JsonPropertyName("status")] public string Status { get; init; } = "";
    [JsonPropertyName("machineId")] public string MachineId { get; init; } = "";
    [JsonPropertyName("bodyweightRawLb")] public double? BodyweightRawLb { get; init; }
    [JsonPropertyName("bodyweightSmoothedLb")] public double? BodyweightSmoothedLb { get; init; }
    [JsonPropertyName("deletedAt")] public long? DeletedAt { get; init; }
}

/// <summary>A session together with the sets logged in it, as the history view needs it.</summary>
public sealed record SessionWithSetsDto
{
    [JsonPropertyName("session")] public SessionDto Session { get; init; } = new();
    [JsonPropertyName("sets")] public IReadOnlyList<SetLogDto> Sets { get; init; } = [];
}

public sealed record MachineDto
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("railProfileId")] public string RailProfileId { get; init; } = "";
    [JsonPropertyName("calibratedAngleDeg")] public double[]? CalibratedAngleDeg { get; init; }
    [JsonPropertyName("isDefault")] public bool? IsDefault { get; init; }
}

public sealed record SettingsDto
{
    [JsonPropertyName("goalPrimary")] public string? GoalPrimary { get; init; }

    /// <summary>
    /// What the trainee SAID they were training for. Kept alongside the derived goal because
    /// "lose weight" and "build muscle" produce the same training style but not the same program.
    /// </summary>
    [JsonPropertyName("aim")] public string? Aim { get; init; }
    [JsonPropertyName("goalSecondary")] public string? GoalSecondary { get; init; }
    [JsonPropertyName("phaseOverride")] public string? PhaseOverride { get; init; }
    [JsonPropertyName("experienceOverride")] public string? ExperienceOverride { get; init; }
    [JsonPropertyName("units")] public string? Units { get; init; }
    [JsonPropertyName("defaultMachineId")] public string? DefaultMachineId { get; init; }

    /// <summary>Null means never configured, which filters nothing. See ExerciseCatalog.Available.</summary>
    [JsonPropertyName("ownedAttachments")] public string[]? OwnedAttachments { get; init; }

    /// <summary>
    /// Which version of the accessory list <see cref="OwnedAttachments"/> answered. Absent means
    /// it predates the registry, so every accessory is unanswered. See ExerciseCatalog.ResolveOwned.
    /// </summary>
    [JsonPropertyName("equipmentVersion")] public int? EquipmentVersion { get; init; }
}

public sealed record PlannedExerciseDto
{
    [JsonPropertyName("exerciseId")] public string ExerciseId { get; init; } = "";
    [JsonPropertyName("sets")] public int Sets { get; init; }
}

public sealed record ProgramSessionDto
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("exercises")] public IReadOnlyList<PlannedExerciseDto> Exercises { get; init; } = [];
}

public sealed record ProgramDto
{
    [JsonPropertyName("id")] public string Id { get; init; } = "";
    [JsonPropertyName("name")] public string Name { get; init; } = "";
    [JsonPropertyName("description")] public string Description { get; init; } = "";
    [JsonPropertyName("sessions")] public IReadOnlyList<ProgramSessionDto> Sessions { get; init; } = [];
    [JsonPropertyName("isActive")] public bool IsActive { get; init; }
}

/// <summary>In-flight shell state, not a stored record. See src/client/src/focus.ts.</summary>
public sealed record FocusDto
{
    [JsonPropertyName("exerciseId")] public string? ExerciseId { get; init; }
}

/// <summary>
/// Source-generated serialization. Reflection-based System.Text.Json breaks under the IL
/// trimming enabled in docs/adr/0002, and the failure only appears after publish -- never in
/// a debug run, which is what makes it expensive to find late.
/// </summary>
[JsonSourceGenerationOptions(PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(SetLogDto))]
[JsonSerializable(typeof(IReadOnlyList<SetLogDto>))]
[JsonSerializable(typeof(ExerciseHistoryDto))]
[JsonSerializable(typeof(IReadOnlyList<ExerciseHistoryDto>))]
[JsonSerializable(typeof(BodyweightDto))]
[JsonSerializable(typeof(IReadOnlyList<BodyweightDto>))]
[JsonSerializable(typeof(SessionDto))]
[JsonSerializable(typeof(IReadOnlyList<SessionDto>))]
[JsonSerializable(typeof(SessionWithSetsDto))]
[JsonSerializable(typeof(IReadOnlyList<SessionWithSetsDto>))]
[JsonSerializable(typeof(MachineDto))]
[JsonSerializable(typeof(IReadOnlyList<MachineDto>))]
[JsonSerializable(typeof(SettingsDto))]
[JsonSerializable(typeof(FocusDto))]
[JsonSerializable(typeof(ProgramDto))]
public sealed partial class LogbookJson : JsonSerializerContext;
