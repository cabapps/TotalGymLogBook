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
    /// <summary>
    /// What an answer with no recorded version answered.
    ///
    /// Version 1, not 0. Those answers came from the panel that stored capability labels, and it
    /// offered exactly the version-1 accessories — so a trainee who left the press-up bars
    /// unticked meant it. Reading them as "answered nothing" would silently re-tick every box
    /// they had deliberately cleared.
    /// </summary>
    private const int LegacyAnswerVersion = 1;

    private readonly Dictionary<string, Exercise> _byId;
    private readonly Dictionary<string, Accessory> _accessoryById;

    public ExerciseCatalog(IEnumerable<Exercise> exercises, IEnumerable<Accessory>? accessories = null)
    {
        ArgumentNullException.ThrowIfNull(exercises);

        All = exercises.ToList();
        Accessories = accessories?.ToList() ?? [];
        _byId = All.ToDictionary(e => e.Id, StringComparer.Ordinal);
        _accessoryById = Accessories.ToDictionary(a => a.Id, StringComparer.Ordinal);
    }

    public IReadOnlyList<Exercise> All { get; }

    /// <summary>Things a trainee can own, and what each one unlocks.</summary>
    public IReadOnlyList<Accessory> Accessories { get; }

    /// <summary>The newest accessory-registry version this catalog knows about.</summary>
    public int AccessoryVersion => Accessories.Count == 0 ? 0 : Accessories.Max(a => a.Added);

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

    /// <summary>Distinct capabilities the catalog's exercises ask for.</summary>
    public IReadOnlyList<string> Attachments =>
        All.Select(e => e.Attachment).OfType<string>().Distinct().Order().ToList();

    /// <summary>
    /// What a stored answer lets the trainee do.
    ///
    /// Entries are accessory ids. An entry matching no accessory is taken as a capability name
    /// verbatim, which is how answers stored before the accessory registry existed keep working:
    /// the panel used to write the requirement label itself, and those labels are still
    /// capability names today.
    /// </summary>
    public IReadOnlySet<string> Capabilities(IEnumerable<string> ownedAttachments)
    {
        ArgumentNullException.ThrowIfNull(ownedAttachments);

        var can = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var entry in ownedAttachments)
        {
            if (_accessoryById.TryGetValue(entry, out var accessory)) can.UnionWith(accessory.Provides);
            else can.Add(entry);
        }

        return can;
    }

    /// <summary>
    /// A stored answer, brought up to date with accessories added since it was given.
    ///
    /// SILENCE IS NOT A NO. A trainee who ticked their equipment last year answered a shorter
    /// question than the one being asked now, so accessories added since count as owned until
    /// they say otherwise. The alternative is that an app update quietly stops the coach
    /// suggesting movements the trainee has been doing for months.
    ///
    /// Null in, null out: never configured is a different state and stays one (see
    /// <see cref="Available"/>).
    /// </summary>
    public IReadOnlyCollection<string>? ResolveOwned(
        IReadOnlyCollection<string>? ownedAttachments, int? answeredVersion = null)
    {
        if (ownedAttachments is null) return null;

        var answered = answeredVersion ?? LegacyAnswerVersion;
        var unanswered = Accessories.Where(a => a.Added > answered).Select(a => a.Id);
        return new HashSet<string>(ownedAttachments.Concat(unanswered), StringComparer.Ordinal);
    }

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

        var can = Capabilities(ownedAttachments);
        return All.Where(e => e.Attachment is null || can.Contains(e.Attachment)).ToList();
    }

    public static ExerciseCatalog Parse(string json)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(json);

        // Source-generated, not reflection-based. Reflection breaks under the IL trimming
        // docs/adr/0002 enables, and only after publish -- never in a debug run, which is what
        // makes that class of failure expensive to find.
        var document = JsonSerializer.Deserialize(json, ExerciseCatalogJson.Default.CatalogDocument)
            ?? throw new FormatException("Exercise catalog is empty.");

        return new ExerciseCatalog(
            document.Exercises.Select(ToExercise),
            // Null-tolerant: a catalog file that predates the accessory registry parses to a
            // catalog with no accessories, which filters exactly as it did before.
            (document.Accessories ?? []).Select(
                a => new Accessory(a.Id, a.Name, a.Provides ?? [], a.Common, a.Added, a.Note)));
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

    /// <summary>
    /// Unknown or absent reads as Even — the neutral value. Unlike a muscle name, a tension label
    /// nobody recognizes is not a data error worth refusing to start over: it only ranks
    /// suggestions, so the safe failure is to stop ranking rather than to stop the app.
    /// </summary>
    private static PeakTension ParseTension(string? name) =>
        Enum.TryParse<PeakTension>(name, ignoreCase: true, out var tension) ? tension : PeakTension.Even;

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
        PeakTension = ParseTension(dto.PeakTension),
        BodyFraction = dto.BodyFraction,
        Attachment = dto.Attachment,
        Muscles = dto.Muscles
            .Select(m => new MuscleInvolvement(ParseMuscle(m.Muscle), m.Fraction))
            .ToList(),
    };
}

/// <summary>
/// Something the trainee can own, and what it lets them do.
///
/// Not the same vocabulary as <see cref="Exercise.Attachment"/>, on purpose. An exercise names a
/// CAPABILITY ("Wing attachment"); an accessory is a PRODUCT that provides one. The wing shipped
/// as one piece and as two, and both do every wing exercise, so an exercise naming the product
/// would hide pull-ups from every owner of the other version.
/// </summary>
public sealed record Accessory(
    string Id,
    string Name,
    IReadOnlyList<string> Provides,
    bool Common,
    int Added,
    string? Note = null);

internal sealed record CatalogDocument
{
    [JsonPropertyName("exercises")]
    public IReadOnlyList<ExerciseDto> Exercises { get; init; } = [];

    [JsonPropertyName("accessories")]
    public IReadOnlyList<AccessoryDto>? Accessories { get; init; }

    internal sealed record AccessoryDto
    {
        public string Id { get; init; } = "";
        public string Name { get; init; } = "";
        public IReadOnlyList<string>? Provides { get; init; }
        public bool Common { get; init; }
        public int Added { get; init; }
        public string? Note { get; init; }
    }

    internal sealed record ExerciseDto
    {
        public string Id { get; init; } = "";
        public string Name { get; init; } = "";
        public string Category { get; init; } = "";
        public string Kind { get; init; } = "strength";
        public bool UsesPulley { get; init; }
        public string? PeakTension { get; init; }
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
