# Tomodachi Life smooth-mode study for Simeioma sketch mode

**Status:** research and visual target only — no Simeioma drawing behaviour changed.

**Decision:** keep adaptive input filtering and uniform dab spacing as the Simeioma *feel* candidate, but split it from a Tomodachi-faithful raster mode. The new 60fps evidence indicates hard pixel coverage rather than a soft anti-aliased edge. Do **not** use a canvas blur filter.

## Executive conclusion

The useful visual distinction is not merely “a smoother curve.” A verified 720p60 Facepaint tutorial shows that **Smooth** is an explicit line option and that its resulting curved stroke reads with hard, pixel-stepped black coverage at reference scale—not with a soft blurred or visibly anti-aliased edge. It changes the prior study in one important way: geometry and raster coverage must be treated separately.

1. **Input stability** — still a strong Simeioma candidate, but not proven by this clip because the tutorial does not expose the live path continuously.
2. **Stroke continuity** — likely needed for a continuous curve, but its exact Nintendo spacing is unresolved.
3. **Raster coverage** — Tomodachi-faithful output should start with opaque, hard pixel coverage. Simeioma may offer a softened canvas edge as a separate product decision, never as evidence of Nintendo’s renderer.

The 60fps check is summarised in [`media/tomodachi-60fps-findings.svg`](media/tomodachi-60fps-findings.svg). The existing [`media/tomodachi-smoothing-comparison.mp4`](media/tomodachi-smoothing-comparison.mp4) remains useful as a **Simeioma adaptive-smoothing study**, not as a faithful raster reconstruction.

> **Important accuracy boundary.** There is no public Nintendo technical specification or usable game decompilation that identifies Palette House’s internal stroke code. The observed curve appears nearly atomically in the tutorial between `02:11.70` and `02:11.88`, so this 60fps stream cannot identify input lag, a 1€ filter, a spline family, or dab spacing. We should call the adaptive version “Tomodachi-inspired,” not “Tomodachi-matched,” until a continuous high-frame-rate reference gesture is measured frame by frame.

## Evidence quality and what it establishes

| Confidence | Source | What it establishes | What it does **not** establish |
| --- | --- | --- | --- |
| High | [W3C Pointer Events Level 3](https://www.w3.org/TR/pointerevents3/) | Pointer input can expose coalesced and predicted events; input rate and sample delivery are separate from rendering. | A Nintendo implementation. |
| High | [MDN: `getCoalescedEvents()`](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents) | Browser `pointermove` can merge moves; drawing apps can recover the underlying samples for a smoother, more accurate path. | That every Tauri webview exposes the API. |
| High | Casiez, Roussel, Vogel, [*1€ Filter* (CHI 2012)](https://gery.casiez.net/1euro/) | A speed-adaptive low-pass filter is a lightweight way to trade slow-motion jitter against fast-motion lag. | Palette House’s exact parameters or algorithm. |
| High, direct visual observation | [cosmicstinggg — *Full Tutorial for Advanced Facepaint Mode*](https://www.youtube.com/watch?v=9H5zd5R2avA&t=131s) | A 1280×720, 60fps stream shows `Smooth` selected in Facepaint. The curved black line has visibly hard/pixel-stepped coverage at the captured scale. | The live input path or the native geometry algorithm: the large curve appears almost atomically between frames in this tutorial. |
| Low / contradicted by the 60fps reference | [Palette House guide](https://tomodachigrid.com/blog/tomodachi-life-palette-house-guide/) | A community description of smooth versus pixel-perfect mode. | The claimed soft/anti-aliased raster edge; the inspected 60fps Facepaint example does not support that claim. |
| Low / negative result | [TL-Decomp](https://github.com/CalebVernon/TL-Decomp) | The available Tomodachi Life decomp is early-stage and does not document the brush pipeline. | Any basis for reverse-engineering the renderer from source today. |
| High | Current Simeioma code: [`src/sketch.ts`](../../src/sketch.ts) | Simeioma currently uses midpoint quadratic interpolation over raw `pointermove` samples, 2px round ink, and stores the raw points. | A stable sampling, temporal filter, dab-spacing, or high-DPI policy. |

## What the existing Simeioma sketch code does

`src/sketch.ts` currently:

- keeps every pointer event in `stroke.points`;
- emits a quadratic segment from the previous point to the midpoint of the next two points;
- renders the same midpoint construction when the note is rehydrated;
- detects line/circle/rectangle intent from the **raw** points on pointer-up;
- paints with a 2px, round-cap, round-join opaque-ish stroke.

That midpoint recipe removes sharp corners, but it does **not** solve temporal jitter or sample-rate variation. A fast move with sparse events and a slow move with dense events get visibly different segment spacing. The current 384×384 bitmap is also CSS-scaled to the available note region, so it has no explicit device-pixel-ratio policy.

## Recommended visual model

### A. Keep truth and display geometry separate

Maintain three streams during a stroke:

```text
raw samples          → shape recognition + persistence truth
filtered samples     → transient drawing display
resampled display    → deterministic replay / export rasterization
```

Never feed filtered points into line/circle/rectangle detection. Filtering changes bounds, length, and closure ratios, which would make recognition inconsistent with what the user drew.

### B. Recover input samples before filtering

For each `pointermove`, consume `event.getCoalescedEvents?.() ?? [event]`. Convert every source event using the existing `canvasPoint()` mapping. On platforms that lack the API, the fallback retains today’s behavior.

### C. Use a speed-adaptive 1€ filter, not fixed blur or a fixed EMA

For each coordinate:

```text
α(cutoff, Δt) = 1 / (1 + 1 / (2π · cutoff · Δt))
x̂t = αxt + (1 − α)x̂t−1
cutoff = minCutoff + beta · |filtered velocity|
```

A fixed filter either remains shaky or becomes noticeably late. A 1€ filter holds more firmly when nearly still and opens at drawing speed.

**First calibration candidate — a starting point, not a final claim about Nintendo:**

```ts
{
  minCutoff: 1.35,       // Hz: calm slow movement
  beta: 0.012,           // opens the filter as px/s rises
  derivativeCutoff: 1.0, // Hz
  spacing: 4.4,          // canonical-canvas px between dabs
}
```

### D. Resample after filtering, then choose coverage deliberately

Walk the filtered polyline and emit a point each 4–5 canonical pixels. Draw overlapping round caps or a round-join path through those points. `ctx.filter = "blur(...)"` is still incorrect: it softens the whole line, muddies intersections, and is not supported by the game reference.

The 60fps check creates two legitimate, separately named rendering choices:

- **Tomodachi-faithful coverage:** opaque hard/pixel coverage after geometry smoothing; no blur and no deliberate soft edge.
- **Simeioma softened coverage:** ordinary high-DPI canvas antialiasing, only if it reads better alongside the app’s post-it visual language. This is a product choice, not a reverse-engineered match.

For the final style pass, tune these independently:

- **geometry:** filter parameters and 4–5px spacing;
- **brush:** width, opacity, colour, cap/join;
- **edge:** hard/pixel or ordinary canvas antialiasing—never Gaussian blur;
- **mode:** smooth/freehand only. Keep the existing recognised geometric shapes crisp.

### Implementation mode contract

Replace the ambiguous `sketchSmoothing` boolean/label with a persisted `sketchRenderingMode` union:

| Value | Geometry | Coverage | Intent |
| --- | --- | --- | --- |
| `legacy` | Existing raw-point midpoint quadratics | Current canvas rendering | Compatibility baseline; existing notes retain their current appearance. |
| `simeioma-adaptive` | Coalesced samples → candidate adaptive filter → fixed-distance resampling | Ordinary high-DPI canvas antialiasing | Simeioma’s refined, calm-ink product treatment. It is not a Nintendo reconstruction. |
| `tomodachi-pixel` | The same candidate geometry pipeline, pending continuous-reference calibration | Opaque, pixel-aligned hard coverage; no blur and no deliberate soft edge | A controlled Tomodachi-inspired raster experiment. The source currently supports its edge treatment, not its filter or spacing. |

All three modes must keep raw points as the persisted truth and must leave recognised lines, circles, and rectangles crisp.

## Scope of work

### Slice 1 — deterministic pure stroke pipeline

- Add a `smoothSketchPoints(raw, options)` pure helper and an arc-length resampler in `src/sketch.ts` or a focused new module.
- Preserve raw points in `SketchStrokeRecord`; replay through the same deterministic smoothing path.
- Add unit tests for: no-op first point, constant-speed path, stationary jitter reduction, fast turn responsiveness, and deterministic replay.
- **Acceptance:** legacy notes still load; the same raw record produces identical raster geometry every replay.

### Slice 2 — live input and high-DPI raster surface

- Consume coalesced events where present, with the ordinary event fallback.
- Render at `CSS size × devicePixelRatio` while retaining the current 384-unit logical coordinate system for persistence.
- Batch display drawing in `requestAnimationFrame`; do not call persistence on `pointermove`.
- **Acceptance:** no visible gaps on fast mouse movement; no blur from browser upscaling; no dropped final segment on pointer-up/leave/cancel.

### Slice 3 — named rendering modes behind an explicit setting

- Add persisted `sketchRenderingMode: "legacy" | "simeioma-adaptive" | "tomodachi-pixel"`; migrate missing values to `legacy` so existing notes do not change silently.
- Apply modes only to freehand records. Keep recognised lines, circles, and rectangles as precise vector-like strokes.
- Implement `tomodachi-pixel` as a hard-coverage renderer with pixel-aligned coordinates/dabs; do not quietly make it a blurred or anti-aliased variant.
- Provide a small local debug fixture that draws the same recorded gesture in all three modes.
- **Acceptance:** user can select each named mode; undo, clear, export, restore, and shape recognition stay correct; reopening a legacy note keeps its existing appearance.

### Slice 4 — reference calibration and human sign-off

- Use the inspected 60fps Facepaint video as a **coverage/style** reference only: it confirms a hard pixel edge, but its tutorial edit does not reveal live stroke evolution.
- Capture or obtain a legally usable continuous 60–120fps reference of Palette House smooth mode: slow straight line, slow circle, quick S-curve, pause/restart, and a sharp turn.
- Overlay Simeioma and the continuous reference at the same canvas scale; tune `minCutoff`, `beta`, spacing, width, and hard-versus-soft coverage one at a time.
- Record final parameter values and before/after clips under `docs/research/media/`.
- **Acceptance:** Guilherme judges the target as visually faithful on a mouse and pen/touch-capable device.

## What not to do

- Do not claim an exact Nintendo algorithm without measured reference frames or source evidence.
- Do not filter persisted truth only at live draw time; replay/export would diverge.
- Do not use only a CSS/canvas blur to fake smoothness.
- Do not apply a temporal filter to recognised geometric shapes.
- Do not make the default smoother until a user-facing A/B comparison is approved.

## Research media

All media below is original, generated from the deterministic study script—not Nintendo footage.

| Asset | Purpose |
| --- | --- |
| [`media/tomodachi-60fps-findings.svg`](media/tomodachi-60fps-findings.svg) | Findings from the inspected YouTube 720p60 Facepaint source: explicit Smooth option, hard coverage, temporal behaviour unresolved. |
| [`media/tomodachi-smoothing-comparison.mp4`](media/tomodachi-smoothing-comparison.mp4) | 3.5s, 24fps animation: raw samples vs current Simeioma midpoint path vs **Simeioma adaptive** study. |
| [`media/tomodachi-smoothing-comparison.gif`](media/tomodachi-smoothing-comparison.gif) | Lightweight looping version for quick review. |
| [`media/tomodachi-smoothing-comparison.png`](media/tomodachi-smoothing-comparison.png) | Final-frame reference. |
| [`media/tomodachi-smoothing-comparison.svg`](media/tomodachi-smoothing-comparison.svg) | Vector final-frame reference. |
| [`generate-tomodachi-smoothing-artifacts.mjs`](generate-tomodachi-smoothing-artifacts.mjs) | Produces the vector reference. |
| [`generate-tomodachi-smoothing-video.ps1`](generate-tomodachi-smoothing-video.ps1) | Uses System.Drawing and FFmpeg to regenerate PNG, MP4, and GIF. |

Regenerate the complete set from the Simeioma repository root:

```powershell
node docs/research/generate-tomodachi-smoothing-artifacts.mjs
pwsh -NoProfile -File docs/research/generate-tomodachi-smoothing-video.ps1
```
