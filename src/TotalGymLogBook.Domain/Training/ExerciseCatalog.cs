using System.Text.Json;
using System.Text.Json.Serialization;

namespace TotalGymLogBook.Domain.Training;

/// <summary>
/// The exercise catalog, parsed from data/exercises.json.
///
/// The TypeScript shell has always had this, because it needs <c>usesPulley</c> and
/// <c>bodyFraction</c> to compute a load before Blazor exists (docs/adr/0003). .NET did not,
/// which is why the coach could only ever say "chest-press" — it had ids and no names, and
/// <see cref="VolumeLedger"/> had no catalog to weigh sets against.
///
/// Same file, two parsers, same argument as the resistance calculator: one source of truth on
/// disk, mirrored where the load-time principle demands it (docs/adr/0009).
/// </summary>
public sealed class ExerciseCatalog
{
    private readonly Dictionary<string, Exercise> _byId;

    public ExerciseCatalog(IEnumerable<Exercise> exercises)
    {
        ArgumentNullException.ThrowIfNull(exercises);

        All = exercises.ToList();
        _byId = All.ToDictionary(e => e.Id, StringComparer.Ordinal);
    }

    public IReadOnlyList<Exercise> All { get; }

    /// <summary>What <see cref="VolumeLedger"/> takes.</summary>
    public IReadOnlyDictionary<string, Exercise> ById => _byId;

    public Exercise? TryGet(string id) => _byId.GetValueOrDefault(id);

    /// <summary>
    /// A display name for an id, falling back to a de-slugged version. The fallback matters:
    /// a set logged against an exercise later removed from the catalog must still be
    /// nameable, because the history is permanent and the catalog is not.
    /// </summary>
    public string NameOf(string id) => TryGet(id)?.Name ?? Prettify(id);

    /// <summary>Movements where this muscle is the prime mover, not incidental.</summary>
    public IReadOnlyList<Exercise> PrimaryFor(MuscleGroup muscle) =>
        All.Where(e => e.InvolvementOf(muscle) >= MuscleInvolvement.Direct).ToList();

    /// <summary>Distinct accessories the catalog references, for the equipment picker.</summary>
    public IReadOnlyList<string> Attachments =>
        All.Select(e => e.Attachment).OfType<string>().Distinct().Order().ToList();

    /// <summary>
    /// Only what the trainee can actually do with the accessories they own.
    ///
    /// NULL means UNCONFIGURED and filters nothing. An empty list means "configured, owns no
    /// accessories" and filters hard. The distinction matters: treating unconfigured as
    /// owns-nothing would hide squats from someone who has been logging squats for months.
    /// </summary>
    public IReadOnlyList<Exercise> Available(IReadOnlyCollection<string>? ownedAttachments = null)
    {
        if (ownedAttachments is null) return All;

        var owned = new HashSet<string>(ownedAttachments, StringComparer.OrdinalIgnoreCase);
        return All.Where(e => e.Attachment is null || owned.Contains(e.Attachment)).ToList();
    }

    public static ExerciseCatalog Parse(string json)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(json);

        // Source-generated, not reflection-based. Reflection breaks under the IL trimming
        // docs/adr/0002 enables, and only after publish -- never in a debug run, which is what
        // makes that class of failure expensive to find.
        var document = JsonSerializer.Deserialize(json, ExerciseCatalogJson.Default.CatalogDocument)
            ?? throw new FormatException("Exercise catalog is empty.");

        return new ExerciseCatalog(document.Exercises.Select(ToExercise));
    }

    /// <summary>
    /// Strict on purpose. A typo in the data file that silently dropped a muscle would quietly
    /// understate that muscle's weekly volume forever, and the coach would then recommend work
    /// the trainee is already doing.
    /// </summary>
    private static MuscleGroup ParseMuscle(string name) =>
        Enum.TryParse<MuscleGroup>(name, ignoreCase: true, out var muscle)
            ? muscle
            : throw new FormatException($"Unknown muscle group '{name}' in the exercise catalog.");

    private static string Prettify(string id) =>
        string.Join(' ', id.Split('-').Where(w => w.Length > 0)
            .Select(w => char.ToUpperInvariant(w[0]) + w[1..]));

    private static Exercise ToExercise(CatalogDocument.ExerciseDto dto) => new()
    {
        Id = dto.Id,
        Name = dto.Name,
        Category = dto.Category,
        Kind = string.Equals(dto.Kind, "stretch", StringComparison.OrdinalIgnoreCase)
            ? ExerciseKind.Stretch
            : ExerciseKind.Strength,
        UsesPulley = dto.UsesPulley,
        BodyFraction = dto.BodyFraction,
        Attachment = dto.Attachment,
        Muscles = dto.Muscles
            .Select(m => new MuscleInvolvement(ParseMuscle(m.Muscle), m.Fraction))
            .ToList(),
    };
}

internal sealed record CatalogDocument
{
    [JsonPropertyName("exercises")]
    public IReadOnlyList<ExerciseDto> Exercises { get; init; } = [];

    internal sealed record ExerciseDto
    {
        public string Id { get; init; } = "";
        public string Name { get; init; } = "";
        public string Category { get; init; } = "";
        public string Kind { get; init; } = "strength";
        public bool UsesPulley { get; init; }
        public double BodyFraction { get; init; } = 1.0;
        public string? Attachment { get; init; }
        public IReadOnlyList<MuscleDto> Muscles { get; init; } = [];
    }

    internal sealed record MuscleDto
    {
        public string Muscle { get; init; } = "";
        public double Fraction { get; init; }
    }
}

[JsonSourceGenerationOptions(PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(CatalogDocument))]
internal sealed partial class ExerciseCatalogJson : JsonSerializerContext;
