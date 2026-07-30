using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using TotalGymLogBook.Domain;
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
    var json = await http.GetStringAsync("data/rail-profiles.json");
    builder.Services.AddSingleton(RailProfileTable.Parse(json));
}

await builder.Build().RunAsync();
