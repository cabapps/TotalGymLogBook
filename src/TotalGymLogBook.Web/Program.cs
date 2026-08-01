using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using Microsoft.Extensions.DependencyInjection;
using TotalGymLogBook.Domain;
using TotalGymLogBook.Domain.Training;
using TotalGymLogBook.Interop;
using TotalGymLogBook.Web;

var builder = WebAssemblyHostBuilder.CreateDefault(args);

// docs/adr/0003 rule 5: the DOM is partitioned by owner. Blazor renders into #blazor-root;
// the web-component shell owns everything outside it and is already interactive by the time
// this runs. Mounting on #app would blow the shell away.
builder.RootComponents.Add<App>("#blazor-root");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp =>
    new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });

// docs/adr/0009: Domain does no I/O. The host fetches the profile table and injects it, which
// is what keeps the calculator testable on the desktop runtime with synthetic profiles.
using (var http = new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) })
{
    var profiles = await http.GetStringAsync("data/rail-profiles.json");
    builder.Services.AddSingleton(RailProfileTable.Parse(profiles));

    // The same catalogue the shell parses. Blazor needs it for two things it could not do
    // before: name an exercise rather than printing its id, and give VolumeLedger the
    // per-muscle involvement it needs to account for a set.
    var exercises = await http.GetStringAsync("data/exercises.json");
    builder.Services.AddSingleton(ExerciseCatalog.Parse(exercises));
}

// Reads through the TypeScript bridge. TypeScript owns IndexedDB exclusively (docs/adr/0003),
// so this is the only route from .NET to the logbook, and it is read-only.
builder.Services.AddSingleton<Logbook>();
builder.Services.AddSingleton<ProgressionEngine>();
builder.Services.AddSingleton<SessionAdvisor>();

var host = builder.Build();

// Import the bundle and subscribe to the change bus before the first render, so components
// never have to special-case "bridge not ready yet".
await host.Services.GetRequiredService<Logbook>().InitialiseAsync();

await host.RunAsync();
