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
    /// <summary>Must match MODULE_NAME in src/client/src/db/bridge.ts.</summary>
    internal const string ModuleName = "tglb-db";

    /// <summary>
    /// Path to the bundle.
    ///
    /// GOTCHA: JSHost.ImportAsync resolves this relative to <c>_framework/</c>, NOT to the app
    /// base. "./dist/shell.js" silently becomes "/_framework/dist/shell.js" and 404s, and the
    /// failure surfaces as an opaque
    /// "AggregateException_ctor_DefaultMessage (TypeError: Failed to fetch dynamically imported
    /// module)" during startup rather than anything naming the path.
    ///
    /// The leading "../" walks back out to the app base, so this is also correct if the app is
    /// ever served from a subpath -- _framework always sits one level under the base.
    ///
    /// The functions imported from here must be NAMED EXPORTS of the esbuild entry point
    /// (main.ts). JSImport resolves against the module's exports, so anything bridge.ts
    /// declares but main.ts does not re-export is invisible.
    /// </summary>
    internal const string ModulePath = "../dist/shell.js";

    private static bool _imported;

    /// <summary>
    /// Imports the bundle so the JSImport bindings below can resolve. Idempotent, and cheap on
    /// repeat: index.html already loaded this exact URL as a module script, and the browser's
    /// module cache returns the same instance rather than re-evaluating it.
    /// </summary>
    internal static async Task EnsureImportedAsync()
    {
        if (_imported) return;
        await JSHost.ImportAsync(ModuleName, ModulePath);
        _imported = true;
    }

    [JSImport("getExerciseHistoryJson", ModuleName)]
    internal static partial Task<string> GetExerciseHistoryJson(string exerciseId, double sinceMs);

    [JSImport("getHistoriesJson", ModuleName)]
    internal static partial Task<string> GetHistoriesJson(double days);

    [JSImport("getRecentSetsJson", ModuleName)]
    internal static partial Task<string> GetRecentSetsJson(double days);

    [JSImport("getBodyweightReadingsJson", ModuleName)]
    internal static partial Task<string> GetBodyweightReadingsJson(string? sinceOn);

    [JSImport("getActiveSessionJson", ModuleName)]
    internal static partial Task<string> GetActiveSessionJson();

    [JSImport("getSessionSetsJson", ModuleName)]
    internal static partial Task<string> GetSessionSetsJson(string sessionId);

    [JSImport("listSessionsJson", ModuleName)]
    internal static partial Task<string> ListSessionsJson(double sinceMs);

    [JSImport("getSettingsJson", ModuleName)]
    internal static partial Task<string> GetSettingsJson();

    [JSImport("listMachinesJson", ModuleName)]
    internal static partial Task<string> ListMachinesJson();

    [JSImport("subscribeToChanges", ModuleName)]
    internal static partial void SubscribeToChanges(
        [JSMarshalAs<JSType.Function<JSType.String, JSType.String>>] Action<string, string> callback);
}
