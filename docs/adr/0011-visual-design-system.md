# 0011 — Visual design system: Apple HIG on the web

**Status:** Accepted

## Context

Eleven web components, each with its own `CSSStyleSheet`, plus four Blazor views with their own
`<style>` blocks. Nothing shared them. `.card` was written out five times with three different
paddings, "small text" meant 0.7rem, 0.75rem, or 0.8125rem depending on which file you opened,
and the same warning state was `#b45309` in one component and `#d97706` in another.

That is what shipped, and it worked, but it looked like fifteen screens rather than one app.

The audience is also specific. This is a phone or an iPad propped in front of an incline
machine, installed to the Home Screen, launched from an icon, with no browser chrome visible
(see [0002](0002-hosting-domain-and-updates.md) and [0008](0008-service-worker-and-offline.md)).
When there is no address bar, the only thing distinguishing the app from a native one is
whether it behaves like the rest of the device.

## Decision

**Follow Apple's Human Interface Guidelines, and encode them once.**

Tokens live in `index.html`. Components live in `src/client/src/shell/theme.ts`, adopted first
by every shadow root, with each component's own sheet adopted second.

The split is forced, not stylistic: **custom properties inherit through shadow boundaries and
stylesheets do not.** A constructed stylesheet cannot reach Blazor's light DOM, and a `<style>`
in `index.html` cannot reach a shadow root. Only the tokens can be in one place and apply to
both tiers, so the palette is declared above both and the components are declared where the
components are.

### What "looks native" actually means

Concrete rules, each of which the code enforces:

| Rule | Where |
|---|---|
| Inset grouped lists — white cards on a gray page, 10pt corners, **no borders** | `.card`, `.rows` |
| Hairline separators inset to the text column, drawn at 0.5px on Retina | `--hairline`, `--separator` |
| 44pt minimum touch target on everything tappable | `--tap` |
| 17pt body text, and never smaller in an input | `--text-body` |
| Apple's system colors, with real dark-mode counterparts | `--system-*` |
| Feedback on touch (dim to 0.45), never on hover | `button:active` |
| Large title that collapses into a translucent nav bar on scroll | `AppShell.#watchTitle` |
| SF Rounded for numbers that *are* the content | `--font-rounded`, `.metric` |

Two of these are behavioral rather than cosmetic and would be worth keeping even if the app
looked nothing like iOS:

- **17px inputs.** Safari zooms the viewport when a field under 16px takes focus, and does not
  zoom back out. Half the fields in the app were 13px, so tapping Reps mid-set left the page
  magnified until the trainee pinched it back.
- **44pt targets.** The app is used with sweaty hands, mid-set, at arm's length.

### Semantic color, not decorative color

Green is a switch that is on. Red is destructive and nothing else. Orange is a warning, and a
warning is a **tinted card**, never an outlined one — an outline is the single most reliable
way to look like a web form. Blue is interactive.

That is why `--warn` is not `--system-orange`: system orange on a white card fails contrast as
body text, so the token carries a darkened variant for text while `--surface-warn` carries the
tint for backgrounds.

## Consequences

- A component now says only what makes it different. The style block in `set-logger.ts` went
  from 38 lines to 25, and most of what is left is about the load readout.
- Redesigns happen in two files instead of fifteen.
- `--border` survives as an alias of `--separator`, so rules written before the palette existed
  degrade to the right thing rather than to nothing.
- Blazor's per-page `<style>` blocks are removed with their markup on navigation, so anything
  shared between derived views has to live in `MainLayout.razor`. Heading styles written in
  `Home.razor` silently stopped applying one tap away, which is how that was discovered.
- The nav bar's large-title collapse needs an `IntersectionObserver` per render, because the
  shell rewrites its shadow root on every screen change.
- `backdrop-filter` is the one effect with no fallback worth writing; without it the bar is
  simply opaque, which is fine.

## Rejected

**A CSS framework.** Every candidate is a network request the CSP blocks
([0008](0008-service-worker-and-offline.md)), a bundle competing with the .NET runtime for the
first paint budget ([0003](0003-blazor-web-components-boundary.md)), and a class vocabulary
that has to be re-learned. The tokens above are 60 lines.

**Copying iOS controls pixel for pixel.** The switch, slider, and stepper are drawn to Apple's
real dimensions (51×31, 28pt thumb) because those sizes are the point. Everything else is the
*idiom*, not a replica — this is a web app, and pretending otherwise breaks the moment
something behaves like the web.

**`<input type="checkbox" switch>`.** Safari 17.4+ renders a real iOS switch from that
attribute, but only Safari, so the app would look correct on the target device and unstyled
everywhere else, including in the headless Chromium the e2e suite drives. Drawn in CSS, it is
the same everywhere.
