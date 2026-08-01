namespace TotalGymLogBook.Domain.Training;

/// <summary>
/// What the program is FOR. Deliberately separate from <see cref="EnergyBalance"/>, which is
/// what the body is DOING. Losing weight is not a training style: a weight-loss user gets a
/// hypertrophy program, because the job of resistance training in a deficit is preserving
/// lean mass, and that needs mechanical tension. See docs/adr/0010.
/// </summary>
public enum GoalType
{
    Hypertrophy,
    Strength,
    Aerobic,

    /// <summary>
    /// First-class because Total Gym has a large physical-therapy install base. Progression is
    /// deliberately de-emphasised; a coach nagging a rehab user to add load is actively harmful.
    /// </summary>
    Rehab
}

/// <summary>
/// Primary drives the rule set; secondary adjusts emphasis. "Lose fat and build muscle" is the
/// most common real pairing, so goals are not mutually exclusive.
/// </summary>
public sealed record TrainingGoal(GoalType Primary, GoalType? Secondary = null)
{
    public bool Includes(GoalType goal) => Primary == goal || Secondary == goal;

    public GoalParameters Parameters => GoalParameters.For(Primary);
}

/// <summary>Per-goal prescription. Table from docs/adr/0010.</summary>
public sealed record GoalParameters
{
    public required GoalType Goal { get; init; }
    public required int MinReps { get; init; }
    public required int MaxReps { get; init; }

    /// <summary>Reps in reserve to leave at the end of a working set.</summary>
    public required int TargetRir { get; init; }

    public required TimeSpan RestBetweenSets { get; init; }

    /// <summary>
    /// Fractional load increase to aim for once the top of the rep range is reached. Strength
    /// work steps load harder; aerobic work progresses by density instead, so it steps least.
    /// </summary>
    public required double LoadStepFraction { get; init; }

    /// <summary>False for rehab, where the coach must not push load at all.</summary>
    public required bool ProgressesLoad { get; init; }

    public static GoalParameters For(GoalType goal) => goal switch
    {
        GoalType.Hypertrophy => new GoalParameters
        {
            Goal = goal, MinReps = 8, MaxReps = 12, TargetRir = 1,
            RestBetweenSets = TimeSpan.FromSeconds(90),
            LoadStepFraction = 0.05, ProgressesLoad = true
        },
        GoalType.Strength => new GoalParameters
        {
            Goal = goal, MinReps = 3, MaxReps = 6, TargetRir = 2,
            RestBetweenSets = TimeSpan.FromMinutes(3),
            LoadStepFraction = 0.075, ProgressesLoad = true
        },
        GoalType.Aerobic => new GoalParameters
        {
            Goal = goal, MinReps = 15, MaxReps = 30, TargetRir = 3,
            RestBetweenSets = TimeSpan.FromSeconds(45),
            LoadStepFraction = 0.025, ProgressesLoad = true
        },
        GoalType.Rehab => new GoalParameters
        {
            Goal = goal, MinReps = 10, MaxReps = 15, TargetRir = 4,
            RestBetweenSets = TimeSpan.FromSeconds(60),
            LoadStepFraction = 0.0, ProgressesLoad = false
        },
        _ => throw new ArgumentOutOfRangeException(nameof(goal), goal, null)
    };
}
