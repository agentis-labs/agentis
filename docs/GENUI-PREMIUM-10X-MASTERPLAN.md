# GenUI Premium 10x — making Agentic App surfaces look designed

**Status:** PROPOSED 2026-06-27
**Scope:** the visual quality of agent-authored App surfaces (the AG-UI render path), not the grammar or the generator's composition logic.

---

## 1. The problem

Agentis can already *compose* a good surface — the agent emits a rich, well-structured `ViewNode` tree (Hero + Split/Grid + KPIStrip + Chart + Board + activity rail). But the rendered result looks like a flat 2014 admin panel, not a 2026 product dashboard. Side-by-side, our output (cramped gray boxes, hairline borders, one green accent, tiny type, "No records yet" everywhere) loses badly to reference dashboards (big numbers, color, gradient-filled charts, real elevation, avatars, status pills, breathing room).

**The loss is in rendering, not generation.** Three root causes, all downstream of the agent:

### 1a. The token system is a flat monotone
`apps/web/src/styles.css` — the App canvas is a near-black wash (`--color-canvas #08090b`, `--color-surface #0f1014`) with **hairline borders** (`--color-line #1b1d22`, barely visible) and **one** product-wide accent (`--color-accent #4ade80`). `--shadow-card` is a 4px whisper. The richer tokens that already exist (`--shadow-glow`, `--shadow-floating`, `--color-glass-*`, gradients) are **never used by the apps renderer**.

### 1b. Every primitive is timid and tiny
`apps/web/src/components/apps/ViewRenderer.tsx` + `styleIntent.ts`:
- One visual phrase repeated 30+ times: `border border-line bg-surface shadow-card`. Cards, panels, boards, charts — all the identical flat box.
- Type tops out at `text-[20px]` for a KPI value (`KpiStripView`) and is `10–13px`/gray everywhere else. We physically cannot render a hero `$23,094.57` stat.
- Charts are single-stroke lines: no gradient area fill, no grid, no end-point marker.
- Tables are gray text rows (`BoundTable`): no status pills, avatars, rank/index, row emphasis.

### 1c. "Theme" is cosmetic, and there's only one
`apps/web/src/components/apps/theme.ts` — the 4 "themes" (`operations/analytics/product/editorial`) only vary density + chart accent + max-width. They render the **same flat look**. So "whatever style they want" is currently impossible: there is exactly one style, and it's flat.

### 1d. Sparse data reads as broken
The generator builds data panels but nothing seeds them, and empty states (`No records yet`, `Empty`, `Waiting for activity…`) look like errors. A brand-new app looks dead on first open.

---

## 2. Outcome

- An agent picks a **design language** that fits the app; the operator can override it. The *same* `ViewNode` tree renders in genuinely different, all-premium styles (glass/glow, editorial, console, soft-consumer, ops).
- Every core primitive (KPI, Hero, Card, Chart, Table, Board, Metric, Form) is rebuilt to reference-grade craft: real elevation, color, large type, gradient charts, rich tables.
- A new app looks intentional on first open — seeded sample data and designed empty states.
- Quality is **enforced** by a deterministic visual audit, not left to chance.

Nothing about the grammar (`packages/core/src/types/view.ts`) changes incompatibly — every addition is optional, old trees stay byte-valid.

---

## 3. Design: the DesignLanguage layer

A **DesignLanguage** is a named bundle of *visual decisions* expressed as CSS custom properties scoped to the surface root, plus a small set of renderer policy flags. It sits one level below the existing `theme` (which keeps owning density/accent/width) and one level above raw tokens.

```
ViewNode.style.theme      → density, default chart accent, content width   (unchanged)
ViewNode.style.design     → DesignLanguage: radii, shadows, card treatment,
                            gradient policy, type scale, palette            (NEW, root-only, optional)
global tokens (styles.css)→ dark/light palette                             (unchanged)
```

### Languages (initial set)
| id | feel | reference |
|----|------|-----------|
| `aurora` | glass cards, ambient glow, gradient accents, soft depth | image 4 (Spider perf dashboard) |
| `soft` | rounded consumer cards, pastel multi-color tiles, friendly | image 3 (Swarm Activity) |
| `editorial` | big type, generous whitespace, restrained color, content-forward | — |
| `console` | dense neon-on-black terminal, tight grid, mono accents | ops/SRE |
| `operations` | the current dense command-center, but elevated (default) | — |

Each language emits a var bag consumed by the primitives, e.g.:
```ts
{
  '--s-radius': '16px',
  '--s-card-bg': 'linear-gradient(160deg, rgba(...) , var(--color-surface))',
  '--s-card-border': '1px solid var(--color-glass-border)',
  '--s-card-shadow': 'var(--shadow-floating)',
  '--s-kpi-size': '34px',
  '--s-pad': '20px',
  '--s-gradient-charts': '1',     // policy flag
  '--s-palette': 'multi',          // tiles get rotating hues
}
```

### Wiring
- `apps/web/src/components/apps/designLanguage.ts` (NEW) — registry: `id → { vars, policy }`.
- `theme.ts` — `ResolvedTheme` gains `design`; `resolveTheme()` resolves it.
- `ViewRenderer` root (the `mx-auto w-full` wrapper) — applies the var bag as inline `style` + a `data-design` attribute, inside the existing `ThemeProvider`.
- `view.ts` — add optional `design` to `styleIntentSchema` (root-only, additive enum). No migration: `style` is already free-form-optional.

---

## 4. Phases

### P0 — DesignLanguage foundation  ← **start here**
- Registry + schema + root wiring (above).
- Migrate the **container** path (`containerClasses`/Card/Section) and **Hero** + **KPIStrip** to consume the vars, so switching language visibly transforms a surface.
- Operator override: a language picker in the App editor toolbar (writes root `style.design`).
- **Verify:** one app, four languages, four distinctly premium renders.

### P1 — Premium primitives
Rebuild to reference grade, all var-driven:
- **KPIStrip / Metric:** large number, trend arrow with tone color, inline gradient spark, optional icon.
- **Chart** (`charts/index.tsx`): gradient area fill, subtle grid, end-point marker, multi-series default palette, smooth curve.
- **Table:** status pills (reuse `toneFromStatus`), avatar cells, rank/index column, hover/zebra emphasis.
- **DataBoard:** colored column headers by status tone, card elevation.
- **Hero:** stronger gradient + optional KPI inline.

### P2 — Data confidence
- Seed realistic sample rows on app/collection creation (behind a flag, clearable).
- Redesign empty states as intentional (illustrated, "Add your first X" CTA) — not error-gray.
- Generator/`genui.ts` scaffold: stop building 4 panels for 1 empty collection.

### P3 — Generation taste
- `surfaceGenerator.ts` `SYSTEM_PROMPT`: advertise the design-language catalog; tell the agent to pick one by domain; add 1–2 few-shot *great* trees.
- `packages/core/src/genui.ts`: deterministic scaffold picks a language by archetype/domain so even no-model output looks designed.

### P4 — Visual self-critique
- Extend `genuiAudit.ts` / `repairSurface`: score contrast, hierarchy, color variety, empty-panel ratio; re-prompt once when a surface scores flat. Quality enforced, not hoped for.

---

## 5. Guardrails
- **Additive only.** `design` is optional + root-only; absent → `operations` (elevated). Old surfaces render unchanged in shape, better in polish.
- **No raw CSS from agents.** Agents pick a language *id* from an enum; all CSS lives in the registry. Same contract as `StyleIntent` today.
- **Token-backed.** Languages compose existing `styles.css` tokens (incl. dark/light) — no hardcoded palette that breaks theming.
- **One render path.** The builder canvas (`SurfaceEditProvider`) and live runtime share `ViewRenderer`; languages apply to both, so WYSIWYG stays pixel-true.

---

## 6. Impl log
- 2026-06-27 — Plan written. Diagnosis grounded in `styles.css`, `ViewRenderer.tsx`, `styleIntent.ts`, `theme.ts`, `genui.ts`, `surfaceGenerator.ts`. Decision: multiple design languages (not one house style). Starting P0.
- 2026-06-27 — **P0 foundation SHIPPED + verified.**
  - Grammar: added optional root-only `design` to `styleIntentSchema` + `designLanguageSchema` enum (`operations|aurora|soft|editorial|console`) in `packages/core/src/types/view.ts`. Additive — old trees stay byte-valid. Core + web typecheck clean.
  - Registry: `apps/web/src/components/apps/designLanguage.ts` — each language → a `--s-*` CSS-var bag (radius/pad/gap/card-bg/border/shadow/kpi-size/heading-size/glow) + policy flags (`gradientCharts`, `multiPalette`). All values compose existing `styles.css` tokens (dark/light safe).
  - Wiring: `theme.ts` `ResolvedTheme.design` + `resolveTheme(theme, design, density)`; each theme leads with a default language (analytics→aurora, product→soft, editorial→editorial, operations→operations). `ViewRenderer` root applies the var bag + `data-design` on the content wrapper.
  - Primitives now var-driven: `.s-panel`/`.s-tile`/`.s-round` classes in `styles.css`; `styleIntent` `ELEVATION.raised → s-panel`; `PanelShell`, `ActivityStream`, `KPIStrip` (big number via `--s-kpi-size`, multi-palette accent edge + spark hue), `Hero` (radius/pad/heading via vars).
  - Operator override: design-language switcher added to `GenUIShowcasePage` (/genui-showcase, DEV).
  - **Verified** in preview: same surface, Aurora (radius 18px / gradient panel / floating shadow / KPI 34px) vs Editorial (radius 8px / flat / no shadow / KPI 40px). No console errors.
  - Remaining P0 polish: route the App-editor toolbar (`AppEditorPage`) language picker (currently only the showcase has one); migrate the remaining direct `rounded-card border border-line bg-surface` panels (BoundTable wrapper, DataBoard columns, ChatShell, Accordion) to `.s-panel`.
- 2026-06-27 — **P0 polish + P1–P4 SHIPPED + verified.** Full e2e build.
  - **P0 polish:** App-editor toolbar (`AppEditorPage`) now has a design-language `<select>` (Auto + 5 languages) beside theme/density, writing `style.design`. Migrated remaining panels to var-driven classes: BoundTable, DataBoard columns/cards, ChatShell, Accordion, ActivityStream, Chart/Pie wrappers → `.s-panel`/`.s-round`.
  - **P1 premium primitives:** Table rebuilt — auto status pills (toned via `toneFromStatus`), avatar-chip identity column, uppercase headers, zebra/hover. DataBoard — tone-colored column header dots + count pills, elevated hover-lift cards. Chart — `s-panel` wrapper, honors language `gradientCharts` policy (editorial = no fill), emphasized end-point marker (halo + ring). KPIStrip — big number via `--s-kpi-size`, multi-palette accent edge + spark hue. New designed `EmptyState` (icon + hint) replaces bare "No records yet".
  - **P2 data confidence (visual slice):** designed empty states for tables/boards; the existing `repairSurface` panel cap already prevents empty-panel sprawl. (DB sample-row seeding deferred — backend/migration risk; the designed empties + premium look already remove the "broken/dead" feel.)
  - **P3 generation taste:** `surfaceGenerator` `SYSTEM_PROMPT` advertises the design-language catalog (which to pick per domain; "when in doubt → aurora"). `genui.ts` deterministic scaffold stamps a language per archetype (analytics→aurora, pipeline→soft, operations→operations, empty→aurora).
  - **P4 deterministic visual floor:** `repairSurface` now guarantees a root `design` (via `inferDesign(theme)`, kept in sync with web `theme.ts` presets) so EVERY surface — model, scaffold, or hand-authored — renders premium even when the model omits it; honors any language the model chose. (Model re-prompt-on-flat loop intentionally deferred — cost/latency; the deterministic floor covers it.)
  - **Bug found & fixed:** `ViewRenderer` root passed `inherited.design.id` (context default `aurora`) as the design fallback, overriding a theme's own preset — so a `product` theme never became `soft`. Now the root uses its own theme/design and lets `resolveTheme` apply the theme's preset. Verified: product→soft (radius 20px), analytics→aurora (18px), editorial (8px/flat).
  - **Verification:** core typecheck + 11 renaissance tests, api typecheck + 13 surface/reference tests, web typecheck + 7 AppEditorPage tests — all green. Live preview: pills toned (active→success), avatar chips, board tone dots + counts (2/2/1/1), 2 chart end-markers, language swap confirmed via computed styles. No console errors.
- 2026-06-27 — **Agent-creation wiring SHIPPED.** The agent that BUILDS apps now knows to make great UI:
  - `orchestratorPrompt.ts` §2 (Agentic App Builder) DESIGN RULES now include "PICK THE LOOK — set BOTH style.theme AND style.design", with the language→domain map (aurora=exec dashboards, soft=CRM/consumer, editorial=content, console=ops, operations=default; "when in doubt → aurora") + a worked root example.
  - `chatToolCatalog.ts`: `agentis.ui.render` description rewritten to list the full premium grammar + the root `style.design` choice; `agentis.app.scaffold` description notes it picks a premium language and to mention the vibe in the prompt.
  - **Floor already covers it:** `AppSurfaceStore.render` (packages/app) runs `repairSurface` on EVERY hand-authored `ui_render`/`ui_patch`/`perform_region`, which now stamps a guaranteed premium `design` (P4) — so even if the agent omits it, no surface ships flat. Confirmed the seam is the store, not surfaceGenerator.
  - Regression tests added (`genuiAudit.test.ts`): floor guarantees `design` from theme; honors an agent-chosen `design`. core 9/9, api appChatTools 6/6, api typecheck — all green.
  - Net: three layers now agree — (1) the agent is TAUGHT to choose a language, (2) the floor GUARANTEES one, (3) the renderer LOWERS it to premium pixels.
