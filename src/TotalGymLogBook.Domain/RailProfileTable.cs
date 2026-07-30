using System.Text.Json;
using System.Text.Json.Serialization;

namespace TotalGymLogBook.Domain;

/// <summary>
/// The set of known rail profiles, keyed by id.
///
/// Domain does no I/O: <see cref="Parse"/> takes JSON text, and the host is responsible for
/// fetching data/rail-profiles.json (via db.ts in the browser, or the filesystem in tests).
/// That keeps this project dependency-free and testable on the desktop runtime.
/// See docs/adr/0009.
/// </summary>
public sealed class RailProfileTable
{
    private readonly Dictionary<string, RailProfile> _byId;

    public RailProfileTable(IEnumerable<RailProfile> profiles)
    {
        ArgumentNullException.ThrowIfNull(profiles);
        _byId = profiles.ToDictionary(p => p.Id, StringComparer.Ordinal);
    }

    public int FormulaVersion { get; init; } = ResistanceCalculator.FormulaVersion;

    public IReadOnlyCollection<RailProfile> Profiles => _byId.Values;

    public RailProfile this[string id] => _byId.TryGetValue(id, out var p)
        ? p
        : throw new KeyNotFoundException($"No rail profile '{id}'.");

    public bool TryGet(string id, out RailProfile? profile) => _byId.TryGetValue(id, out profile);

    /// <summary>Profile matching a notch count. Onboarding asks users to count notches
    /// rather than name their model, because the FIT and FIT Anniversary share a name but
    /// have 12 and 14 levels. See docs/adr/0010.</summary>
    public RailProfile ForLevelCount(int levelCount) =>
        _byId.Values.SingleOrDefault(p => p.LevelCount == levelCount)
        ?? throw new KeyNotFoundException($"No rail profile with {levelCount} levels.");

    public static RailProfileTable Parse(string json)
    {
        var doc = JsonSerializer.Deserialize(json, RailProfileJson.Default.RailProfileFileDto)
                  ?? throw new InvalidDataException("rail-profiles.json deserialised to null.");

        var profiles = doc.Profiles.Select(p => new RailProfile
        {
            Id = p.Id,
            AngleDeg = p.AngleDeg,
            BoardWeightLb = p.BoardWeightLb,
            AngleSource = Enum.Parse<AngleSource>(p.AngleSource, ignoreCase: true),
            Verified = p.Verified
        }).ToList();

        foreach (var p in profiles)
        {
            if (p.LevelCount != doc.Profiles.Single(d => d.Id == p.Id).LevelCount)
            {
                throw new InvalidDataException(
                    $"Profile '{p.Id}' declares levelCount that disagrees with its angleDeg length.");
            }
        }

        return new RailProfileTable(profiles) { FormulaVersion = doc.FormulaVersion };
    }
}

// DTOs mirror data/rail-profiles.json. Unmapped keys ($comment, notes) are ignored.
internal sealed record RailProfileFileDto(
    [property: JsonPropertyName("formulaVersion")] int FormulaVersion,
    [property: JsonPropertyName("profiles")] IReadOnlyList<RailProfileDto> Profiles);

internal sealed record RailProfileDto(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("levelCount")] int LevelCount,
    [property: JsonPropertyName("angleDeg")] IReadOnlyList<double> AngleDeg,
    [property: JsonPropertyName("boardWeightLb")] double BoardWeightLb,
    [property: JsonPropertyName("angleSource")] string AngleSource,
    [property: JsonPropertyName("verified")] bool Verified);

/// <summary>Source-generated context. Reflection-based System.Text.Json breaks under the IL
/// trimming enabled in docs/adr/0002, and the failure only shows up after publish.</summary>
[JsonSourceGenerationOptions(PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(RailProfileFileDto))]
internal sealed partial class RailProfileJson : JsonSerializerContext;
