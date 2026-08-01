using TotalGymLogBook.Domain.Training;

namespace TotalGymLogBook.Domain.Tests;

public sealed class ProgramEmphasisTests
{
    private static readonly ExerciseCatalog Catalog = ExerciseCatalog.Parse(
        RepoData.Read("exercises.json"));

    [Fact]
    public void Losing_fat_still_gets_a_muscle_building_program()
    {
        // docs/adr/0010: losing weight is not a training style. What changes is which movements
        // the program is built out of, not whether it is a lifting program.
        Assert.Equal(GoalType.Hypertrophy, TrainingAim.LoseFat.ToGoal());
        Assert.Equal(ProgramEmphasis.LargestMuscles, ProgramEmphasisRules.For(TrainingAim.LoseFat));
    }

    [Fact]
    public void An_observed_deficit_counts_the_same_as_a_stated_one()
    {
        // Someone who set out to build muscle but has been losing weight for a month is, whatever
        // they intended, training in a deficit — and the same reasoning about lean mass applies.
        Assert.Equal(
            ProgramEmphasis.LargestMuscles,
            ProgramEmphasisRules.For(TrainingAim.BuildMuscle, EnergyBalance.Deficit));

        Assert.Equal(
            ProgramEmphasis.Lengthened,
            ProgramEmphasisRules.For(TrainingAim.BuildMuscle, EnergyBalance.Maintenance));
    }

    [Fact]
    public void Building_muscle_ranks_a_stretch_movement_above_a_squeeze()
    {
        var fly = Catalog.TryGet("chest-fly")!;
        var raise = Catalog.TryGet("lateral-raise")!;

        Assert.True(ProgramEmphasis.Lengthened.Score(fly) > ProgramEmphasis.Lengthened.Score(raise));
    }

    [Fact]
    public void Losing_fat_ranks_the_biggest_muscles_first()
    {
        // The point of the emphasis: a squat builds more tissue than a curl, and more muscle is
        // more resting metabolism. The same pair ranks the other way for nothing else.
        var squat = Catalog.TryGet("squat")!;
        var curl = Catalog.TryGet("concentration-curl")!;

        Assert.True(
            ProgramEmphasis.LargestMuscles.Score(squat)
            > ProgramEmphasis.LargestMuscles.Score(curl));
    }

    [Fact]
    public void A_gentle_program_does_not_lead_with_loaded_stretches()
    {
        // Rehab is the one place the stretch bias is wrong: the whole point is to stay inside a
        // range the trainee is cleared for.
        var fly = Catalog.TryGet("chest-fly")!;
        var row = Catalog.TryGet("seated-row")!;

        Assert.True(ProgramEmphasis.Gentle.Score(row) > ProgramEmphasis.Gentle.Score(fly));
    }

    [Fact]
    public void Quads_outrank_biceps()
    {
        // The only ordering claim RelativeMass actually needs to get right.
        Assert.True(MuscleGroup.Quadriceps.RelativeMass() > MuscleGroup.Biceps.RelativeMass());
        Assert.True(MuscleGroup.Back.RelativeMass() > MuscleGroup.Calves.RelativeMass());
    }

    [Fact]
    public void An_aim_stored_before_the_field_existed_falls_back_to_the_goal()
    {
        Assert.Equal(TrainingAim.GetStronger, ProgramEmphasisRules.ParseAim(null, GoalType.Strength));
        Assert.Equal(TrainingAim.Rehab, ProgramEmphasisRules.ParseAim(null, GoalType.Rehab));
        Assert.Equal(TrainingAim.LoseFat, ProgramEmphasisRules.ParseAim("lose-fat", GoalType.Hypertrophy));
    }

    [Fact]
    public void Every_exercise_declares_where_it_loads_the_muscle()
    {
        Assert.Contains(Catalog.All, e => e.PeakTension == PeakTension.Lengthened);
        Assert.Contains(Catalog.All, e => e.PeakTension == PeakTension.Shortened);

        // The obvious ones, so a data edit that inverts the table fails loudly.
        Assert.True(Catalog.TryGet("chest-fly")!.IsLengthenedLoaded);
        Assert.True(Catalog.TryGet("squat")!.IsLengthenedLoaded);
        Assert.Equal(PeakTension.Shortened, Catalog.TryGet("lateral-raise")!.PeakTension);
        Assert.Equal(PeakTension.Shortened, Catalog.TryGet("crunch")!.PeakTension);
    }

    [Fact]
    public void An_unreadable_tension_label_does_not_stop_the_app()
    {
        // Unlike a muscle name, this only ranks suggestions. The safe failure is to stop ranking,
        // not to refuse to start.
        const string json = """
        { "exercises": [ { "id": "x", "name": "X", "peakTension": "sideways",
          "muscles": [ { "muscle": "Chest", "fraction": 1 } ] } ] }
        """;

        Assert.Equal(PeakTension.Even, ExerciseCatalog.Parse(json).TryGet("x")!.PeakTension);
    }
}
