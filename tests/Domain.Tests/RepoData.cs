using System.Text.Json;
using System.Text.Json.Serialization;

namespace TotalGymLogBook.Domain.Tests;

/// <summary>Locates and loads files from the repo's data/ directory. Domain itself does no
/// I/O (docs/adr/0009); the tests act as the host that supplies it data.</summary>
internal static class RepoData
{
    private static readonly Lazy<string> DataDir = new(() =>
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var candidate = Path.Combine(dir.FullName, "data", "rail-profiles.json");
            if (File.Exists(candidate)) return Path.Combine(dir.FullName, "data");
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not locate the repo data/ directory above " + AppContext.BaseDirectory);
    });

    public static string Path_(string fileName) => Path.Combine(DataDir.Value, fileName);

    public static string Read(string fileName) => File.ReadAllText(Path_(fileName));

    public static RailProfileTable Profiles() => RailProfileTable.Parse(Read("rail-profiles.json"));

    public static T ReadJson<T>(string fileName) =>
        JsonSerializer.Deserialize<T>(Read(fileName), JsonOpts)
        ?? throw new InvalidDataException($"{fileName} deserialized to null.");

    public static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        WriteIndented = true
    };
}

internal sealed record PublishedChartFile(
    [property: JsonPropertyName("bodyweightLb")] IReadOnlyList<double> BodyweightLb,
    [property: JsonPropertyName("samples")] IReadOnlyList<PublishedChartRow> Samples);

internal sealed record PublishedChartRow(
    [property: JsonPropertyName("profileId")] string ProfileId,
    [property: JsonPropertyName("level")] int Level,
    [property: JsonPropertyName("publishedLb")] IReadOnlyList<double> PublishedLb);
