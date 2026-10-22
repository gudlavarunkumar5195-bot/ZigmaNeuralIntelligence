# Frontend design system

The product UI uses one visual language: a dark navigation rail, a light working surface, an electric-indigo accent and a teal highlight. Everything here is plain React, Tailwind CSS 4 and lucide-react. There is no component library dependency.

## Where things live

| What | File |
| --- | --- |
| Tokens, Tailwind theme, type scale, base styles, motion | `src/index.css` |
| Shared class strings (buttons, inputs, cards, pills, tables) | `src/components/ui/styles.ts` |
| Components | `src/components/ui/*.tsx` |
| App shell, sidebar, top bar, drawer, command launcher | `src/components/layout/Shell.tsx` |
| Navigation model (groups, routes, titles, unavailable flags) | `src/components/layout/navigation.ts` |
| Auth page frame | `src/pages/auth/AuthLayout.tsx` |

## Tokens

Semantic CSS variables use the `--zn-*` prefix on `:root`. New code should prefer them (or the Tailwind names mapped from them in `@theme inline`: `bg-surface`, `text-ink`, `border-line`, `bg-accent-main` and so on).

- **Surfaces:** `--zn-bg` (page), `--zn-surface` (cards), `--zn-surface-sunken`, `--zn-surface-hover`.
- **Text:** `--zn-text`, `--zn-text-2`, `--zn-text-muted`. Muted text is at least 4.5:1 on white.
- **Lines:** `--zn-border`, `--zn-border-strong`.
- **Brand:** `--zn-accent` (#5146e5), `--zn-accent-hover`, `--zn-accent-soft`, `--zn-accent-text`, `--zn-highlight` (teal), `--zn-focus`.
- **Status:** `--zn-success`, `--zn-warning`, `--zn-danger` and `--zn-info`, each with a `-soft` background.
- **Sidebar:** `--zn-sidebar`, `--zn-sidebar-raised`, `--zn-sidebar-border`, `--zn-sidebar-text`, `--zn-sidebar-text-strong`, `--zn-sidebar-active`, `--zn-sidebar-accent`.
- **Charts:** `--zn-chart-1` to `--zn-chart-6` for series, in that order, and `--zn-chart-grid` for grid lines.
- **Geometry:** radii `--zn-radius-sm|-|lg|xl`, `--zn-sidebar-width` (248px), `--zn-sidebar-collapsed` (64px), `--zn-topbar-height` (60px), `--zn-content-max` (1360px), `--zn-control-height` (36px).
- **Elevation:** `--zn-shadow-sm`, `--zn-shadow`, `--zn-shadow-lg`.

### Re-skin of the Tailwind palette

Existing pages use Tailwind's `slate-*` and `blue-*` classes heavily. Rather than rewrite every class, `@theme` remaps:

- `slate-50…950` to the cool "ink" neutrals;
- `blue-50…950` to the indigo accent (`blue-600` is the accent, `blue-700` its hover);
- `sky-50/100/600/700/800` to teal.

So `bg-blue-600` is the brand accent everywhere. Other Tailwind colours (emerald, amber, red, violet) are unchanged and used only for status.

### Font weights

Tailwind 4 does not generate the numeric `font-400` … `font-800` classes the codebase used, so before this phase they produced no CSS. They are defined as `@utility` in `index.css`. Use `font-600` for labels and buttons, `font-700` for headings and KPI values, and avoid `font-800` in new code.

## Typography

Plus Jakarta Sans for UI and JetBrains Mono for code, ids and eyebrows.

| Utility | Use |
| --- | --- |
| `text-page-title` | The page `h1`, rendered by `PageHeader` |
| `text-section-title` | Section `h2` inside a page |
| `text-card-title` | Card and chart titles |
| `text-kpi` | KPI values (tabular numbers) |
| `text-eyebrow` | Mono uppercase label above a title (module or group) |
| `text-meta` | Small muted metadata: period, source, freshness |

Body copy in tables and forms is 13px (`text-[13px]`) and helper text is 11–12px.

## Layout

- **Shell:** the sidebar (248px, collapsible to a 64px icon rail at `lg` and above, a modal drawer below that) plus a 60px top bar. Content is centred to 1360px with 16px side padding on phones and 32px on desktop.
- **Page:** every routed page starts with `PageHeader` (eyebrow = navigation group, title, subtitle, actions on the right; they wrap below on narrow screens). Module tabs follow it as `RouteTabs`, then the content. Pages do not add their own outer padding or max-width.
- **Grids:** KPI rows are `grid-cols-1 sm:grid-cols-2 xl:grid-cols-4`. Wide tables scroll horizontally inside `TableContainer`, never the page.
- **Breakpoints checked:** 1440, 1024, 768 and 390 px.

## Components

| Component | Notes |
| --- | --- |
| `Button`, `IconButton` (`Button.tsx`) | Variants primary, secondary, ghost, danger, dangerSolid; sizes sm, md, lg, icon. `loading` disables the button and shows a spinner. `IconButton` requires `aria-label`. For plain elements, use `buttonClass(variant, size)` from `styles.ts`. |
| `PageHeader`, `SectionHeader`, `Card`, `MetricCard`, `FindingRow` (`Card.tsx`) | `PageHeader` is the only `h1` on a page. |
| `KpiCard`, `Delta`, `Sparkline` (`Kpi.tsx`) | `Delta` shows an arrow, sign and screen-reader words ("up 12.5%, better"), so colour is never the only signal. `format`: `pct` (fraction), `pts` (a fraction shown as points, for shares), `abs` (raw number). A `Sparkline` breaks at null values and is not drawn with fewer than two points. |
| `Badge`, `Freshness`, `SourceLabel`, `Notice`, `Field`, `RouteTabs`, `TableContainer`, `ChartFrame`, `LegendItem`, `Skeleton` (`Primitives.tsx`) | `Notice` is a `role="note"` callout. `Field` wires the label, hint and error to the control (`aria-describedby`, `aria-invalid`). `RouteTabs` are links: pass `current` when a route param decides the active tab; otherwise the URL does. `ChartFrame` gives a chart a text summary (`role="img"` with an accessible name) and loading and empty states. |
| `Dialog`, `ConfirmDialog` (`Dialog.tsx`) | Native `<dialog>` with `showModal()`: focus trap, Escape and focus return come from the browser. The confirm button names the action ("Stop scan", "Delete project"). |
| `ToastProvider`, `useToast` (`Toast.tsx`) | Polite live region. Success and info toasts disappear after 5 s; errors stay until dismissed. Without a provider, `useToast` is a no-op. |
| `Tooltip`, `InfoTip` (`Tooltip.tsx`) | Shown on hover and keyboard focus, closed with Escape, linked by `aria-describedby`. Never put essential information only in a tooltip. |
| `LoadingState`, `EmptyState`, `ErrorState`, `IntegrationRequiredState`, `PartialResult`, `NotMeasured` (`DataState.tsx`) | Every data view has loading, empty, error and partial states. `ErrorState` takes `onRetry`. |
| `StatusBadge`, `SeverityBadge` | Always text plus colour. |
| `UnavailableAnalysis` | The honest placeholder for modules that do not exist yet. |

## Honesty rules (product requirements, not style)

- Never show a figure that was not measured or imported. Missing data is "—" or "Not measured", never 0.
- Every metric names its source and period (`KpiCard` `source`/`period`, `Freshness`, `SourceLabel`).
- Modules without a backend are labelled **N/A** in the navigation (`unavailable: true` in `navigation.ts`) and render `UnavailableAnalysis` or "Not available yet". They are never hidden behind fake content.
- No demo customers, invented counts or marketing claims anywhere in the app, including the login page (`src/tests/production-data.test.ts` enforces part of this).

## Accessibility

- Visible focus ring (`--zn-focus`) on every interactive element; a "Skip to content" link; one `h1` per page; landmarks: `nav` Primary, `nav` Breadcrumb, `main#zn-main`.
- The sidebar groups use `aria-expanded`; the collapse toggle uses `aria-pressed`; the mobile drawer is a modal dialog (Escape closes it, body scroll is locked, it closes on navigation); the command launcher (Ctrl/⌘ K) is a native dialog with a listbox and `aria-activedescendant`.
- Icons next to text are `aria-hidden`; icon-only buttons have an `aria-label`.
- Motion is limited to short fades and slides, and `prefers-reduced-motion` turns it off.

## Charts

Use recharts inside `ChartFrame`. Colours come from `--zn-chart-*`, gridlines from `--zn-chart-grid`, and axis labels from `--zn-text-muted` at 11px. Put the main series first. Turn off animation (`isAnimationActive={false}`) for data that refreshes. Every chart needs a one-sentence `summary` stating what it shows and its latest value.
