using System.Runtime.Versioning;

// This assembly is a Blazor WebAssembly app: it only ever executes in a browser. Declaring
// that makes calls into the [SupportedOSPlatform("browser")] members of
// TotalGymLogBook.Interop correct rather than merely tolerated, so CA1416 stays on and would
// still fire if this code were ever moved into a host that runs elsewhere.
[assembly: SupportedOSPlatform("browser")]
