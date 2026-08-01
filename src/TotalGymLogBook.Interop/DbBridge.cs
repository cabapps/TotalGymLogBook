using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;

namespace TotalGymLogBook.Interop;

/// <summary>
/// Raw [JSImport] declarations bound to the TypeScript bridge.
///
/// This class deliberately contains no logic. TypeScript owns IndexedDB exclusively
/// (docs/adr/0003), the boundary carries only JSON strings and ids (rule 2), and the parsing
/// lives in Domain.Persistence where it is testable on the desktop runtime.
///
/// [JSImport] uses direct marshalling rather than IJSRuntime (rule 1) -- no JSON round-trip
/// through the dispatcher, and errors surface at compile time rather than as a runtime
/// "method not found".
///
/// Everything here is READ-ONLY. The write path belongs to the instant tier, because logging a
/// set must work before this runtime exists at all.
/// </summary>
[SupportedOSPlatform("browser")]
internal static partial class DbBridge
{
    /// <summary>
    /// Lookup root for every binding below. The identifier must match GLOBAL_NAME in
    /// src/client/src/db/bridge.ts.
    ///
    /// GOTCHA: the "globalThis." prefix is REQUIRED. [JSImport("tglbDb.someFn")] does not
    /// resolve against the global scope -- it fails at first call with
    /// "tglbDb not found while looking up tglbDb.someFn", wrapped in an opaque
    /// AggregateException_ctor_DefaultMessage, even when globalThis.tglbDb is demonstrably an
    /// object in the page. The failure happens during startup, so the symptom is simply that
    /// nothing Blazor renders ever appears.
    /// </summary>
    private const string Global = "globalThis.tglbDb";

    /// <summary>
    /// No-op, kept so callers need not care how the binding is resolved.
    ///
    /// Previously this called JSHost.ImportAsync against the bundle URL, which was fragile in
    /// two separate ways: ImportAsync resolves relative to _framework/ rather than the app
    /// base, and the dev server fingerprints static assets at serve time (dist/shell.<hash>.js)
    /// while publish leaves the name alone -- so any URL hardcoded here was wrong in one
    /// environment or the other. Rooting the bindings at a globalThis path removes the URL
    /// from the picture entirely. The shell publishes the handle during boot, well before
    /// Blazor.start().
    /// </summary>
    internal static Task EnsureImportedAsync() => Task.CompletedTask;

    [JSImport(Global + ".getExerciseHistoryJson")]
    internal static partial Task<string> GetExerciseHistoryJson(string exerciseId, double sinceMs);

    [JSImport(Global + ".getHistoriesJson")]
    internal static partial Task<string> GetHistoriesJson(double days);

    [JSImport(Global + ".getRecentSetsJson")]
    internal static partial Task<string> GetRecentSetsJson(double days);

    [JSImport(Global + ".getBodyweightReadingsJson")]
    internal static partial Task<string> GetBodyweightReadingsJson(string? sinceOn);

    [JSImport(Global + ".getActiveSessionJson")]
    internal static partial Task<string> GetActiveSessionJson();

    [JSImport(Global + ".getSessionSetsJson")]
    internal static partial Task<string> GetSessionSetsJson(string sessionId);

    [JSImport(Global + ".listSessionsJson")]
    internal static partial Task<string> ListSessionsJson(double sinceMs);

    [JSImport(Global + ".getSessionHistoryJson")]
    internal static partial Task<string> GetSessionHistoryJson(double days);

    /// <summary>Soft-deletes a session and its sets. The one WRITE on this bridge, and it is
    /// here rather than in the instant tier because deleting is a considered act done from the
    /// history view, not something that has to work before the runtime boots.</summary>
    [JSImport(Global + ".deleteSessionJson")]
    internal static partial Task<string> DeleteSessionJson(string sessionId);

    [JSImport(Global + ".purgeEmptySessionsJson")]
    internal static partial Task<string> PurgeEmptySessionsJson();

    [JSImport(Global + ".getSettingsJson")]
    internal static partial Task<string> GetSettingsJson();

    [JSImport(Global + ".listMachinesJson")]
    internal static partial Task<string> ListMachinesJson();

    [JSImport(Global + ".getFocusJson")]
    internal static partial string GetFocusJson();

    [JSImport(Global + ".subscribeToChanges")]
    internal static partial void SubscribeToChanges(
        [JSMarshalAs<JSType.Function<JSType.String, JSType.String>>] Action<string, string> callback);
}
