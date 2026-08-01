using System.Text.Json;
using TotalGymLogBook.Domain.Training;

namespace TotalGymLogBook.Domain.Tests;

public sealed class ProgramAnalyzerTests
{
    private static readonly ExerciseCatalog Catalog = ExerciseCatalog.Parse(
        RepoData.Read("exercises.json"));

    private static readonly VolumeTarget Target = VolumeTarget.For(ExperienceLevel.Novice);

    private readonly ProgramAnalyzer _analyzer = new();

    private static TrainingProgram Program(params (string Exercise, int Sets)[] exercises) =>
        new("p", "Test",
        [
            new ProgramSession("s1", "Session",
                exercises.Select(e => new PlannedExercise(e.Exercise, e.Sets)).ToList()),
        ]);

    [Fact]
    public void Counts_planned_sets_per_muscle()
    {
        // Chest press is chest 1.0, triceps 0.5, shoulders 0.5.
        var weekly = _analyzer.WeeklySets(Program(("chest-press", 4)), Catalog);

        Assert.Equal(4, weekly[MuscleGroup.Chest]);
        Assert.Equal(2, weekly[MuscleGroup.Triceps]);
        Assert.Equal(2, weekly[MuscleGroup.Shoulders]);
    }

    [Fact]
    public void Adds_up_across_sessions()
    {
        var program = new TrainingProgram("p", "Test",
        [
            new ProgramSession("a", "A", [new PlannedExercise("chest-press", 3)]),
            new ProgramSession("b", "B", [new PlannedExercise("chest-press", 2)]),
        ]);

        Assert.Equal(5, _analyzer.WeeklySets(program, Catalog)[MuscleGroup.Chest]);
    }

    [Fact]
    public void Ignores_a_movement_the_catalog_no_longer_has()
    {
        // A plan outlives the exercise it names when a custom movement is deleted. Skipping it
        // understates the total, which is the safe direction -- it can only make the app
        // suggest more work, never less.
        var weekly = _analyzer.WeeklySets(Program(("chest-press", 3), ("ghost-lift", 5)), Catalog);

        Assert.Equal(3, weekly[MuscleGroup.Chest]);
    }

    [Fact]
    public void Does_not_count_a_stretch_as_planned_volume()
    {
        var weekly = _analyzer.WeeklySets(Program(("hamstring-stretch", 5)), Catalog);

        Assert.False(weekly.ContainsKey(MuscleGroup.Hamstrings));
    }

    [Fact]
    public void Reports_what_a_program_never_trains_without_calling_it_a_fault()
    {
        // A muscle at zero is nearly always a deliberate choice about what the split covers --
        // hardly any real program isolates the adductors. Treating that as a defect made the
        // app wrong about three of its own shipped templates.
        var critique = _analyzer.Critique(Program(("chest-press", 4)), Catalog, Target);

        Assert.Contains("Nothing in it trains", critique.Untrained);
        Assert.Contains("deliberate", critique.Untrained);
        Assert.DoesNotContain(critique.Warnings, w => w.Contains("Nothing"));
        Assert.Contains(critique.Volumes, v => v.Muscle == MuscleGroup.Calves && v.Untrained);
    }

    [Fact]
    public void Untrained_muscles_are_not_shortfalls()
    {
        var critique = _analyzer.Critique(Program(("biceps-curl", 2)), Catalog, Target);

        // Biceps is trained-but-thin; everything else is simply not in the program.
        Assert.All(critique.Shortfalls, v => Assert.False(v.Untrained));
        Assert.Contains(critique.Shortfalls, v => v.Muscle == MuscleGroup.Biceps);
    }

    [Fact]
    public void Flags_a_muscle_that_is_trained_but_thinly()
    {
        // Two sets of curls is training biceps, just not enough of it. That reads differently
        // from "nothing in here trains biceps" and is reported differently.
        var critique = _analyzer.Critique(Program(("biceps-curl", 2)), Catalog, Target);
        var warning = Assert.Single(critique.Warnings, w => w.StartsWith("Biceps"));

        Assert.Contains("2 sets", warning);
        Assert.Contains("under the 4", warning);
    }

    [Fact]
    public void Reports_a_clean_program_as_clean()
    {
        var program = new TrainingProgram("p", "Everything",
        [
            new ProgramSession("s", "S",
                Enum.GetValues<MuscleGroup>()
                    .Select(m => Catalog.PrimaryFor(m).FirstOrDefault())
                    .OfType<Exercise>()
                    .DistinctBy(e => e.Id)
                    .Select(e => new PlannedExercise(e.Id, 6))
                    .ToList()),
        ]);

        var critique = _analyzer.Critique(program, Catalog, Target);

        Assert.Empty(critique.Shortfalls);
        Assert.Empty(critique.Warnings);
        Assert.Equal("", critique.Untrained);
        Assert.Contains("takes care of itself", critique.Verdict);
    }

    [Fact]
    public void Never_warns_about_doing_too_much()
    {
        // Same reasoning as the ledger: nothing here can observe recovery (docs/adr/0010).
        var critique = _analyzer.Critique(Program(("chest-press", 40)), Catalog, Target);

        Assert.DoesNotContain(critique.Warnings, w => w.Contains("too", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void Handles_an_empty_program()
    {
        var critique = _analyzer.Critique(new TrainingProgram("p", "Empty", []), Catalog, Target);

        Assert.Contains("nothing in it", critique.Verdict);
    }

    [Fact]
    public void Speaks_English_about_gaps()
    {
        var critique = _analyzer.Critique(Program(("chest-press", 4)), Catalog, Target);

        // "calves, glutes, or quads" -- not "calves, glutes, quads".
        Assert.Contains(", or ", critique.Untrained);
    }

    [Fact]
    public void Counts_the_shortfalls_in_the_verdict()
    {
        var critique = _analyzer.Critique(Program(("biceps-curl", 2)), Catalog, Target);

        Assert.Contains("1 muscle group", critique.Verdict);
        Assert.Contains("is under", critique.Verdict);
    }
}

/// <summary>
/// The shipped templates are data, and data with a typo in it is a plan the trainee cannot
/// action. These parse the real file rather than a fixture.
/// </summary>
public sealed class ProgramTemplateTests
{
    private static readonly ExerciseCatalog Catalog = ExerciseCatalog.Parse(
        RepoData.Read("exercises.json"));

    private sealed record TemplateFile(IReadOnlyList<TemplateDto> Templates);
    private sealed record TemplateDto(
        string Id, string Name, string Emphasis, string Description, string BestFor,
        IReadOnlyList<SessionDto> Sessions);
    private sealed record SessionDto(string Id, string Name, IReadOnlyList<PlannedDto> Exercises);
    private sealed record PlannedDto(string ExerciseId, int Sets);

    private static readonly VolumeTarget Target = VolumeTarget.For(ExperienceLevel.Novice);

    private static readonly IReadOnlyList<TemplateDto> Templates =
        JsonSerializer.Deserialize<TemplateFile>(RepoData.Read("programs.json"), RepoData.JsonOpts)!
            .Templates;

    [Fact]
    public void Agrees_with_the_shell_on_a_shipped_template()
    {
        // The twin of 'agrees with the C# analyzer on a shipped template' in
        // src/client/test/emphasis.test.ts. Two implementations of the same accounting exist
        // because the editor needs the numbers live in the shell and the coach needs them here
        // (docs/adr/0009); this pair is what catches one drifting from the other.
        var weekly = new ProgramAnalyzer()
            .WeeklySets(ToProgram(Templates.Single(t => t.Id == "push-pull-legs")), Catalog);

        Assert.Equal(7, weekly[MuscleGroup.Chest]);
        Assert.Equal(14, weekly[MuscleGroup.Back]);
        Assert.Equal(7, weekly[MuscleGroup.Quadriceps]);
        Assert.Equal(10, weekly[MuscleGroup.Biceps]);
        Assert.Equal(11.5, weekly[MuscleGroup.Glutes]);
    }

    [Fact]
    public void Every_planned_exercise_exists()
    {
        foreach (var template in Templates)
        {
            foreach (var planned in template.Sessions.SelectMany(s => s.Exercises))
            {
                Assert.True(
                    Catalog.TryGet(planned.ExerciseId) is not null,
                    $"{template.Id} plans '{planned.ExerciseId}', which is not in the catalog");
            }
        }
    }

    [Fact]
    public void Every_template_has_a_description_worth_reading()
    {
        Assert.All(Templates, t =>
        {
            Assert.False(string.IsNullOrWhiteSpace(t.Name));
            Assert.True(t.Description.Length > 40, $"{t.Id} needs a real description");
            Assert.False(string.IsNullOrWhiteSpace(t.BestFor));
            Assert.NotEmpty(t.Sessions);
        });
    }

    [Fact]
    public void Shipped_templates_run_on_a_stock_machine()
    {
        // A template is a promise that the trainee can follow it. Planning a leg pull accessory
        // movement for someone who owns a bare machine breaks that promise one exercise at a
        // time, and they only find out by scrolling a picker that does not contain it.
        var stock = Catalog.Accessories.Where(a => a.Common).Select(a => a.Id).ToList();
        var runnable = Catalog.Available(stock).Select(e => e.Id).ToHashSet();

        foreach (var template in Templates)
        {
            foreach (var planned in template.Sessions.SelectMany(s => s.Exercises))
            {
                Assert.True(
                    runnable.Contains(planned.ExerciseId),
                    $"{template.Id} plans '{planned.ExerciseId}', which needs an accessory that "
                    + "does not ship with most machines");
            }
        }
    }

    private static TrainingProgram ToProgram(TemplateDto template) =>
        new(template.Id, template.Name,
            template.Sessions
                .Select(s => new Domain.Training.ProgramSession(s.Id, s.Name,
                    s.Exercises.Select(e => new PlannedExercise(e.ExerciseId, e.Sets)).ToList()))
                .ToList());

    private static ProgramEmphasis EmphasisOf(TemplateDto template) => template.Emphasis switch
    {
        "lengthened" => ProgramEmphasis.Lengthened,
        "largest-muscles" => ProgramEmphasis.LargestMuscles,
        "heavy-compounds" => ProgramEmphasis.HeavyCompounds,
        "circuit" => ProgramEmphasis.Circuit,
        "gentle" => ProgramEmphasis.Gentle,
        _ => throw new FormatException($"{template.Id} has emphasis '{template.Emphasis}'")
    };

    [Fact]
    public void Every_way_of_training_the_app_asks_about_has_a_program_behind_it()
    {
        // Onboarding offers five answers. An answer with no program behind it is a question the
        // app had no business asking.
        Assert.Equal(
            Enum.GetValues<ProgramEmphasis>().ToHashSet(),
            Templates.Select(EmphasisOf).ToHashSet());
    }

    [Fact]
    public void A_muscle_building_template_is_built_out_of_stretch_loaded_movements()
    {
        // The claim the emphasis makes. Loaded work at long muscle lengths grows a muscle more
        // than the same sets through a shortened range, and a template that says 'lengthened'
        // while being mostly squeeze movements is lying to the trainee who picked it.
        var analyzer = new ProgramAnalyzer();

        foreach (var template in Templates.Where(t => t.Emphasis == "lengthened"))
        {
            var tension = analyzer.Tension(ToProgram(template), Catalog);

            Assert.True(tension.LengthenedShare >= 0.5,
                $"{template.Id} is only {tension.LengthenedShare:P0} stretch-loaded");
            Assert.True(tension.Lengthened > tension.Shortened, template.Id);
        }
    }

    [Fact]
    public void A_fat_loss_template_spends_its_sets_on_the_biggest_muscles()
    {
        // Training barely dents the calorie side; its job in a deficit is keeping and adding lean
        // mass, and the most of that sits on the legs and back.
        var big = new[]
        {
            MuscleGroup.Quadriceps, MuscleGroup.Back, MuscleGroup.Glutes,
            MuscleGroup.Hamstrings, MuscleGroup.Chest,
        };

        foreach (var template in Templates.Where(t => t.Emphasis == "largest-muscles"))
        {
            var planned = template.Sessions.SelectMany(s => s.Exercises).ToList();
            var onBigMuscles = planned
                .Where(p => Catalog.TryGet(p.ExerciseId) is { } e
                            && big.Any(m => e.InvolvementOf(m) >= MuscleInvolvement.Direct))
                .Sum(p => p.Sets);

            var share = (double)onBigMuscles / planned.Sum(p => p.Sets);
            Assert.True(share >= 0.7, $"{template.Id} puts only {share:P0} of its sets on big muscles");
        }
    }

    [Fact]
    public void A_rehab_template_never_leads_a_trainee_into_a_loaded_stretch()
    {
        foreach (var template in Templates.Where(t => t.Emphasis == "gentle"))
        {
            Assert.Equal(0, new ProgramAnalyzer().Tension(ToProgram(template), Catalog).Lengthened);
        }
    }

    [Fact]
    public void The_volume_yardstick_follows_the_goal()
    {
        // The effective dose is a hypertrophy number. Holding a rehab program to it would have
        // the app calling a program a failure for being exactly what the trainee asked for.
        var gentle = Templates.Single(t => t.Emphasis == "gentle");
        var program = ToProgram(gentle);
        var analyzer = new ProgramAnalyzer();

        var asRehab = analyzer.Critique(program, Catalog, Target, ProgramEmphasis.Gentle);
        var asGrowth = analyzer.Critique(program, Catalog, Target, ProgramEmphasis.Lengthened);

        Assert.Empty(asRehab.Warnings);
        Assert.NotEmpty(asGrowth.Warnings);
        Assert.Contains("cleared for", asRehab.EmphasisNote);

        // Suppressing the volume warnings does not suppress the reporting: a gap is still named,
        // whatever the goal. The trainee is told and never blocked.
        var narrow = new TrainingProgram("p", "Arms only",
            [new Domain.Training.ProgramSession("s", "S", [new PlannedExercise("biceps-curl", 3)])]);

        Assert.Contains(
            "Nothing in it trains",
            analyzer.Critique(narrow, Catalog, Target, ProgramEmphasis.Gentle).Untrained);
    }

    [Theory]
    [InlineData("full-body")]
    [InlineData("upper-lower")]
    [InlineData("push-pull-legs")]
    [InlineData("big-muscle-full-body")]
    [InlineData("strength-upper-lower")]
    public void Shipped_templates_clear_the_effective_dose_where_they_claim_to(string id)
    {
        // The point of shipping a template is that it works out of the box. A split that leaves
        // a muscle it is SUPPOSED to cover under the effective dose is a bug in the data.
        var template = Templates.Single(t => t.Id == id);
        var weekly = new ProgramAnalyzer().WeeklySets(ToProgram(template), Catalog);

        // Everything a shipped template DOES train must clear the effective dose. A template
        // the app criticizes on the day it ships is a bug in the data, and this caught exactly
        // that -- calves at two sets in Full Body, calves and core at three in PPL.
        foreach (var (muscle, sets) in weekly.Where(kv => kv.Value > 0))
        {
            Assert.True(
                sets >= VolumeTarget.MinimumEffectiveDose,
                $"{id} gives {muscle.Label()} only {sets:0.#} sets a rotation");
        }
    }
}
