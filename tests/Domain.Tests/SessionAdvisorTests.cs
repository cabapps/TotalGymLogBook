using TotalGymLogBook.Domain.Training;

namespace TotalGymLogBook.Domain.Tests;

public sealed class ExerciseCatalogTests
{
    private const string Json = """
    {
      "exercises": [
        { "id": "chest-press", "name": "Chest Press", "usesPulley": true, "bodyFraction": 1.0,
          "attachment": null, "muscles": [
            { "muscle": "Chest", "fraction": 1.0 }, { "muscle": "Triceps", "fraction": 0.5 } ] },
        { "id": "squat", "name": "Squat", "usesPulley": false, "bodyFraction": 0.85,
          "attachment": "Squat stand", "muscles": [
            { "muscle": "Quadriceps", "fraction": 1.0 }, { "muscle": "Glutes", "fraction": 1.0 } ] }
      ]
    }
    """;

    [Fact]
    public void Parses_the_catalogue()
    {
        var catalog = ExerciseCatalog.Parse(Json);

        Assert.Equal(2, catalog.All.Count);
        Assert.Equal("Chest Press", catalog.NameOf("chest-press"));
        Assert.True(catalog.TryGet("chest-press")!.UsesPulley);
        Assert.Equal(0.85, catalog.TryGet("squat")!.BodyFraction, 3);
    }

    [Fact]
    public void Maps_muscle_names_onto_the_enum()
    {
        var press = ExerciseCatalog.Parse(Json).TryGet("chest-press")!;

        Assert.Equal(1.0, press.InvolvementOf(MuscleGroup.Chest));
        Assert.Equal(0.5, press.InvolvementOf(MuscleGroup.Triceps));
        Assert.Equal(0, press.InvolvementOf(MuscleGroup.Calves));
    }

    [Fact]
    public void Rejects_an_unknown_muscle_rather_than_dropping_it()
    {
        // Silently skipping would understate that muscle's weekly volume forever, and the coach
        // would then recommend work the trainee is already doing.
        const string bad = """
        { "exercises": [ { "id": "x", "name": "X", "muscles": [ { "muscle": "Lats", "fraction": 1 } ] } ] }
        """;

        Assert.Throws<FormatException>(() => ExerciseCatalog.Parse(bad));
    }

    [Fact]
    public void Names_an_exercise_that_is_no_longer_in_the_catalogue()
    {
        // History is permanent; the catalogue is not. A set logged against a removed exercise
        // must still be nameable.
        Assert.Equal("Cable Woodchop", ExerciseCatalog.Parse(Json).NameOf("cable-woodchop"));
    }

    [Fact]
    public void Filters_to_owned_attachments()
    {
        var catalog = ExerciseCatalog.Parse(Json);

        Assert.Single(catalog.Available());
        Assert.Equal(2, catalog.Available(["Squat stand"]).Count);
    }

    [Fact]
    public void Parses_the_real_catalogue_file()
    {
        // The shipped data file is the thing that actually has to parse. A muscle name typo
        // here is a build-time failure rather than a silent volume undercount at runtime.
        var catalog = ExerciseCatalog.Parse(RepoData.Read("exercises.json"));

        Assert.NotEmpty(catalog.All);
        Assert.All(catalog.All, e =>
        {
            Assert.False(string.IsNullOrWhiteSpace(e.Id));
            Assert.False(string.IsNullOrWhiteSpace(e.Name));
            Assert.NotEmpty(e.Muscles);
        });
    }
}

public sealed class SessionAdvisorTests
{
    private static readonly ExerciseCatalog Catalog = new(
    [
        new Exercise
        {
            Id = "squat", Name = "Squat",
            Muscles = [new(MuscleGroup.Quadriceps, 1.0), new(MuscleGroup.Glutes, 1.0)],
        },
        new Exercise
        {
            Id = "biceps-curl", Name = "Biceps Curl",
            Muscles = [new(MuscleGroup.Biceps, 1.0)],
        },
        new Exercise
        {
            Id = "seated-row", Name = "Seated Row",
            Muscles = [new(MuscleGroup.Back, 1.0), new(MuscleGroup.Biceps, 0.5)],
        },
        new Exercise
        {
            Id = "pull-up", Name = "Pull-up", Attachment = "Press-up bars",
            Muscles = [new(MuscleGroup.Back, 1.0), new(MuscleGroup.Biceps, 1.0)],
        },
    ]);

    private static readonly VolumeTarget Target = VolumeTarget.For(ExperienceLevel.Novice);

    private static MuscleVolume Volume(MuscleGroup muscle, double sets, int? days = 2) =>
        new(muscle, sets, days);

    private readonly SessionAdvisor _advisor = new();

    [Fact]
    public void Says_nothing_when_nothing_has_been_trained()
    {
        var summary = Enum.GetValues<MuscleGroup>()
            .Select(m => new MuscleVolume(m, 0, null))
            .ToList();

        Assert.Same(SessionAdvice.Silent, _advisor.Advise(summary, Catalog, Target));
    }

    [Fact]
    public void Never_nags_about_a_muscle_that_has_never_been_trained()
    {
        // Skipping calves entirely is a programme choice, not a gap.
        var summary = new List<MuscleVolume>
        {
            Volume(MuscleGroup.Quadriceps, 9),
            new(MuscleGroup.Calves, 0, null),
        };

        var advice = _advisor.Advise(summary, Catalog, Target);

        Assert.DoesNotContain(advice.Gaps, g => g.Muscle == MuscleGroup.Calves);
    }

    [Fact]
    public void Flags_a_muscle_trained_before_but_short_this_week()
    {
        var summary = new List<MuscleVolume>
        {
            Volume(MuscleGroup.Quadriceps, 9),
            Volume(MuscleGroup.Biceps, 1),
        };

        var advice = _advisor.Advise(summary, Catalog, Target);

        var gap = Assert.Single(advice.Gaps);
        Assert.Equal(MuscleGroup.Biceps, gap.Muscle);
        Assert.Equal(3, gap.ShortfallSets);
    }

    [Fact]
    public void Draws_the_contrast_the_trainee_actually_feels()
    {
        var summary = new List<MuscleVolume>
        {
            Volume(MuscleGroup.Quadriceps, 9),
            Volume(MuscleGroup.Biceps, 1),
        };

        var advice = _advisor.Advise(summary, Catalog, Target);

        Assert.Contains("9 sets into quads", advice.Headline);
        Assert.Contains("1 into biceps", advice.Headline);
        Assert.Contains("Biceps Curl", advice.Headline);
    }

    [Fact]
    public void Skips_the_contrast_when_the_two_are_close()
    {
        // Comparing 4.5 against 3.5 invites fixing something that is not broken.
        var summary = new List<MuscleVolume>
        {
            Volume(MuscleGroup.Quadriceps, 4.5),
            Volume(MuscleGroup.Biceps, 3.5),
        };

        var advice = _advisor.Advise(summary, Catalog, Target);

        Assert.DoesNotContain("quads", advice.Headline);
        Assert.Contains("Biceps are at 3.5 sets", advice.Headline);
    }

    [Fact]
    public void Suggests_only_movements_where_the_gap_muscle_is_the_prime_mover()
    {
        // Filling a biceps gap with more rows is how the gap got there.
        var summary = new List<MuscleVolume> { Volume(MuscleGroup.Biceps, 1) };

        var gap = Assert.Single(_advisor.Advise(summary, Catalog, Target).Gaps);

        Assert.Contains(gap.Fixes, e => e.Id == "biceps-curl");
        Assert.DoesNotContain(gap.Fixes, e => e.Id == "seated-row");
    }

    [Fact]
    public void Does_not_suggest_equipment_the_trainee_does_not_own()
    {
        var summary = new List<MuscleVolume> { Volume(MuscleGroup.Biceps, 1) };

        var gap = Assert.Single(_advisor.Advise(summary, Catalog, Target).Gaps);

        Assert.DoesNotContain(gap.Fixes, e => e.Id == "pull-up");
    }

    [Fact]
    public void Prefers_movements_the_trainee_already_knows()
    {
        var summary = new List<MuscleVolume> { Volume(MuscleGroup.Biceps, 1) };

        var gap = Assert.Single(_advisor
            .Advise(summary, Catalog, Target, ["Press-up bars"], ["pull-up"])
            .Gaps);

        Assert.Equal("pull-up", gap.Fixes[0].Id);
    }

    [Fact]
    public void Reports_at_most_a_handful_of_gaps()
    {
        var summary = Enum.GetValues<MuscleGroup>()
            .Select(m => Volume(m, 0))
            .ToList();

        Assert.Equal(SessionAdvisor.MaxGaps, _advisor.Advise(summary, Catalog, Target).Gaps.Count);
    }

    [Fact]
    public void Confirms_when_everything_is_covered()
    {
        var summary = new List<MuscleVolume>
        {
            Volume(MuscleGroup.Quadriceps, 9),
            Volume(MuscleGroup.Biceps, 6),
        };

        var advice = _advisor.Advise(summary, Catalog, Target);

        Assert.False(advice.HasGaps);
        Assert.Contains("Nothing to patch up", advice.Headline);
    }

    [Fact]
    public void Never_warns_about_doing_too_much()
    {
        var summary = new List<MuscleVolume> { Volume(MuscleGroup.Quadriceps, 45) };

        var advice = _advisor.Advise(summary, Catalog, Target);

        Assert.False(advice.HasGaps);
        Assert.DoesNotContain("too much", advice.Headline, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("too many", advice.Headline, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    // Most muscle labels are plural, and "shoulders is at 1 sets" made it to a screenshot.
    [InlineData(MuscleGroup.Shoulders, "Shoulders are at 1 set ")]
    [InlineData(MuscleGroup.Biceps, "Biceps are at 1 set ")]
    [InlineData(MuscleGroup.Chest, "Chest is at 1 set ")]
    [InlineData(MuscleGroup.Core, "Core is at 1 set ")]
    public void Speaks_English(MuscleGroup muscle, string expected)
    {
        var advice = _advisor.Advise([Volume(muscle, 1)], Catalog, Target);

        Assert.Contains(expected, advice.Headline);
    }

    [Theory]
    [InlineData(0, "0 sets")]
    [InlineData(1, "1 set")]
    [InlineData(1.5, "1.5 sets")]
    [InlineData(4, "4 sets")]
    public void Counts_sets_in_English(double count, string expected) =>
        Assert.Equal(expected, MuscleGroups.Sets(count));

    [Fact]
    public void A_deficit_lowers_the_recommendation_but_not_the_floor()
    {
        // docs/adr/0010: holding is the win in a deficit. The minimum effective dose is still
        // the minimum effective dose.
        var cutting = VolumeTarget.For(ExperienceLevel.Advanced, EnergyBalance.Deficit);

        Assert.Equal(VolumeTarget.MinimumEffectiveDose, cutting.MinimumEffectiveSets);
        Assert.True(cutting.RecommendedSets < VolumeTarget.For(ExperienceLevel.Advanced).RecommendedSets);
    }
}
