/**
 * The shared look: Apple's Human Interface Guidelines, applied to a web app.
 *
 * Every shadow root adopts this sheet FIRST and its own sheet second, so a component overrides
 * the system where it genuinely differs and inherits it everywhere else. Before this existed,
 * eleven components each carried their own copy of `.card`, their own button padding, and their
 * own idea of what a small font was -- which is why the app looked like eleven apps.
 *
 * What makes something read as native iOS is not a blue accent. It is a short list of concrete
 * rules, and they are the rules this file encodes:
 *
 *   - Inset grouped lists. Content sits on white cards floating on a gray page, corners 10pt,
 *     rows separated by hairlines that start where the text starts, not at the card edge.
 *   - 44pt minimum touch target. Everything tappable. No exceptions, because the exception is
 *     always the one the user is trying to hit at the gym with sweaty hands.
 *   - 17pt body text. Also the smallest size any INPUT may be: Safari zooms the viewport when
 *     you focus a field under 16px, and the page never zooms back.
 *   - System colors, not hand-picked ones. They are what iOS actually draws, they have real
 *     dark-mode counterparts, and they carry meaning -- green is a switch, red is destructive,
 *     orange is a warning.
 *   - Feedback on touch, never on hover. A phone has no hover. iOS dims a control to ~0.4
 *     opacity while your finger is down and that is the whole animation.
 *
 * The design TOKENS live in index.html rather than here, because custom properties inherit
 * through shadow boundaries but stylesheets do not: Blazor's light-DOM views need the same
 * palette, and one definition is the only way both tiers can be the same color.
 */

const ios = new CSSStyleSheet();
ios.replaceSync(`
  * { box-sizing: border-box; }

  :host { display: block; }
  /*
    A host with display:block beats [hidden], which sets display:none at the same specificity
    but loses on source order. Every component that can be hidden needs this, so it lives here
    once rather than being rediscovered per component.
  */
  :host([hidden]) { display: none; }

  /* ---------------------------------------------------------------- text */

  h1, h2, h3, h4 { font-weight: 600; letter-spacing: -0.01em; }
  h1 { font-size: var(--text-title1); letter-spacing: -0.022em; margin: 0 0 .25rem; }
  h2 { font-size: var(--text-title3); margin: 0 0 .35rem; }
  h3 { font-size: var(--text-headline); margin: 0; }
  h4 { font-size: var(--text-subhead); margin: 0; }

  p { margin: 0 0 .5rem; font-size: var(--text-subhead); line-height: 1.45; color: var(--muted); }

  /*
    A grouped-list section header. Uppercase footnote in secondary label, indented to the card's
    text column so the heading lines up with the rows it introduces.
  */
  .section-header {
    font-size: var(--text-footnote); font-weight: 400; letter-spacing: .04em;
    text-transform: uppercase; color: var(--muted);
    margin: 1.35rem var(--gutter) .4rem; display: block;
  }

  /* ---------------------------------------------------------------- grouping */

  /*
    The inset grouped section. No border -- iOS separates a card from the page by VALUE
    (white on gray), and a 1px outline around it reads as a web form immediately.
  */
  .card {
    background: var(--surface);
    border: 0;
    border-radius: var(--radius-card);
    padding: var(--card-pad-y) var(--gutter);
    margin: 0 0 var(--group-gap);
  }

  /*
    Hairline separators between rows, inset to the text column. The inset is the tell: a rule
    that runs the full width of the card is a table, and a rule that starts under the label is
    an iOS list.
  */
  .rows { list-style: none; margin: 0; padding: 0; }
  .rows > li,
  .row-item {
    display: flex; align-items: center; gap: .6rem;
    min-height: var(--tap);
    padding: .35rem 0;
  }
  .rows > li + li,
  .row-item + .row-item { border-top: var(--hairline) solid var(--separator); }

  /* ---------------------------------------------------------------- controls */

  button {
    font: inherit;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    cursor: pointer;
  }
  /* iOS acknowledges a touch by dimming, and does it instantly. Hover states are for mice. */
  button:active { opacity: .45; }
  @media (hover: hover) {
    button:not(:disabled):hover { opacity: .8; }
  }

  /* The filled action button: full width, 50pt tall, semibold, continuous corners. */
  button.primary {
    display: flex; align-items: center; justify-content: center;
    width: 100%; min-height: 3.125rem; margin-top: 1rem;
    border: 0; border-radius: var(--radius-control);
    background: var(--accent); color: #fff;
    font-size: var(--text-headline); font-weight: 600;
  }
  button.primary:disabled { background: var(--fill-strong); color: var(--faint); opacity: 1; }

  /* The plain button: text only, in the tint color. iOS uses these far more than filled ones. */
  button.ghost {
    display: flex; align-items: center; justify-content: center;
    width: 100%; min-height: var(--tap); margin-top: .35rem;
    border: 0; background: none; color: var(--accent);
    font-size: var(--text-body);
  }
  button.destructive { color: var(--danger); }

  /*
    The small gray button -- iOS's tinted style, used for anything sitting inside a card next to
    content rather than terminating a screen.
  */
  button.action, button.step, button.kill, button.demo-toggle {
    display: inline-flex; align-items: center; justify-content: center;
    min-height: 2rem; padding: 0 .75rem;
    border: 0; border-radius: var(--radius-small);
    background: var(--fill); color: var(--accent);
    font-size: var(--text-subhead); font-weight: 500;
  }
  button.action.primary {
    width: auto; min-height: 2rem; margin-top: 0;
    background: var(--accent); color: #fff;
  }

  /* ---------------------------------------------------------------- fields */

  input, select, textarea {
    font: inherit;
    /*
      17px, and the reason is behavioral rather than aesthetic: Safari zooms the viewport when a
      field smaller than 16px takes focus, and it does not zoom back out afterwards. A trainee
      who taps Reps mid-set should not have to pinch the page back into shape.
    */
    font-size: var(--text-body);
    color: var(--fg);
    background: var(--fill);
    border: 0; border-radius: var(--radius-field);
    appearance: none; -webkit-appearance: none;
    -webkit-tap-highlight-color: transparent;
  }
  input, textarea, select { width: 100%; min-height: var(--tap); padding: .55rem .7rem; }
  input[type=range], input[type=checkbox] { min-height: 0; padding: 0; background: none; }
  /* iOS has no spinner arrows on a number field -- it has a numeric keyboard. The arrows are a
     desktop affordance that shrinks the tap target of every number in the app. */
  input[type=number] { -moz-appearance: textfield; }
  input[type=number]::-webkit-inner-spin-button,
  input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }

  /* Keyboard users get a focus ring; touch and mouse users do not. */
  :focus { outline: none; }
  :focus-visible { outline: max(2px, 0.12em) solid var(--accent); outline-offset: 2px; }

  label {
    display: block; font-size: var(--text-subhead); color: var(--muted);
    margin: .9rem 0 .3rem;
  }

  /*
    A select is a menu button: gray fill, value in the tint color, chevrons trailing. The glyph
    is systemGray, which is the one system color Apple ships IDENTICALLY in light and dark, so a
    single data URI covers both schemes.
  */
  select {
    padding-right: 2rem;
    background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='13' height='20' fill='none' stroke='%238e8e93' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3.5 8L6.5 5l3 3M3.5 12l3 3 3-3'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right .7rem center;
  }

  /*
    The slider. An iOS thumb is a 28pt white disc with a real shadow, riding a 4pt track that is
    tinted behind it and gray ahead of it. --pct is set by whoever owns the value; without it
    the track is simply untinted, which is correct for a slider nobody has touched.
  */
  input[type=range] {
    width: 100%; height: var(--tap); margin: 0;
    background: none;
  }
  input[type=range]::-webkit-slider-runnable-track {
    height: .25rem; border-radius: .125rem;
    background: linear-gradient(
      to right,
      var(--accent) var(--pct, 0%), var(--fill-strong) var(--pct, 0%));
  }
  input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 1.75rem; height: 1.75rem; margin-top: -.75rem;
    border-radius: 50%; background: #fff;
    box-shadow: 0 .1875rem .5rem rgb(0 0 0 / .15), 0 .0625rem .0625rem rgb(0 0 0 / .16);
  }
  input[type=range]::-moz-range-track {
    height: .25rem; border-radius: .125rem; background: var(--fill-strong);
  }
  input[type=range]::-moz-range-progress {
    height: .25rem; border-radius: .125rem; background: var(--accent);
  }
  input[type=range]::-moz-range-thumb {
    width: 1.75rem; height: 1.75rem; border: 0; border-radius: 50%; background: #fff;
    box-shadow: 0 .1875rem .5rem rgb(0 0 0 / .15);
  }

  /*
    The switch. Green when on, because on iOS green means "this setting is on" and blue means
    "this is a link" -- swapping them is the kind of thing that reads as wrong without anyone
    being able to say why. 51x31pt, which is the real UISwitch size.
  */
  input[type=checkbox] {
    flex: 0 0 auto; position: relative;
    width: 3.1875rem; height: 1.9375rem; border-radius: 999px;
    background: var(--fill-strong);
    transition: background-color .2s ease;
  }
  input[type=checkbox]::after {
    content: ''; position: absolute; top: .125rem; left: .125rem;
    width: 1.6875rem; height: 1.6875rem; border-radius: 50%;
    background: #fff;
    box-shadow: 0 .1875rem .5rem rgb(0 0 0 / .15), 0 .0625rem .0625rem rgb(0 0 0 / .16);
    transition: transform .2s ease;
  }
  input[type=checkbox]:checked { background: var(--system-green); }
  input[type=checkbox]:checked::after { transform: translateX(1.25rem); }

  /*
    The stepper. One gray capsule split by a hairline, not two separate buttons -- iOS draws
    UIStepper as a single control and the seam is what says "these two belong together".
  */
  .stepper {
    display: flex; align-items: stretch;
    border-radius: var(--radius-field); background: var(--fill);
    overflow: hidden;
  }
  .stepper button {
    flex: 0 0 3.25rem; min-height: var(--tap);
    border: 0; background: none; color: var(--fg);
    font-size: var(--text-title3); font-weight: 400;
  }
  .stepper button:first-child { border-right: var(--hairline) solid var(--separator); }
  .stepper button:last-child { border-left: var(--hairline) solid var(--separator); }
  .stepper input {
    flex: 1; text-align: center; background: none; border-radius: 0;
    font-size: var(--text-title3); font-variant-numeric: tabular-nums;
  }

  /* ---------------------------------------------------------------- numbers */

  /*
    The big readout. Rounded is SF's numeric face and what iOS uses anywhere a number is the
    content rather than a label -- the Fitness rings, the timer, the scale.
  */
  .metric {
    font-family: var(--font-rounded);
    font-size: var(--text-metric); font-weight: 700; line-height: 1;
    letter-spacing: -0.02em; font-variant-numeric: tabular-nums;
  }

  .tabular { font-variant-numeric: tabular-nums; }

  /* Motion is decoration here; everything still says what it says without it. */
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }
`);

export { ios };
