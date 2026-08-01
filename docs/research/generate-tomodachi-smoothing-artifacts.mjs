import { mkdir, rm, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const media = join(root, "media");
const frames = join(media, ".frames");
const width = 1080;
const height = 640;
const frameCount = 84;
const fps = 24;

await rm(frames, { recursive: true, force: true });
await mkdir(frames, { recursive: true });

const raw = Array.from({ length: frameCount }, (_, index) => {
  const t = index / (frameCount - 1);
  const x = 84 + t * 914 + Math.sin(index * 2.21) * 4.8 + Math.sin(index * 0.47) * 2.1;
  const y = 342 - Math.sin(t * Math.PI * 1.92) * 126 + Math.cos(index * 1.83) * 5.9 + Math.sin(index * 0.31) * 3.4;
  return { x, y, t: index / fps };
});

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

function lowPass(previous, next, a) {
  return previous === undefined ? next : previous + a * (next - previous);
}

// A small, deterministic 1€ filter. It removes still-hand chatter while opening up
// at speed, which is the key visual behaviour we want to evaluate later in Simeioma.
function oneEuro(points, minCutoff = 1.35, beta = 0.012, derivativeCutoff = 1.0) {
  let previousX;
  let previousY;
  let derivativeX;
  let derivativeY;
  let previousTime;
  return points.map((point) => {
    if (previousTime === undefined) {
      previousTime = point.t;
      previousX = point.x;
      previousY = point.y;
      return { x: point.x, y: point.y };
    }
    const dt = Math.max(point.t - previousTime, 1 / 240);
    const dx = (point.x - previousX) / dt;
    const dy = (point.y - previousY) / dt;
    const derivativeAlpha = alpha(derivativeCutoff, dt);
    derivativeX = lowPass(derivativeX, dx, derivativeAlpha);
    derivativeY = lowPass(derivativeY, dy, derivativeAlpha);
    const speed = Math.hypot(derivativeX, derivativeY);
    const pointAlpha = alpha(minCutoff + beta * speed, dt);
    previousX = lowPass(previousX, point.x, pointAlpha);
    previousY = lowPass(previousY, point.y, pointAlpha);
    previousTime = point.t;
    return { x: previousX, y: previousY };
  });
}

function resample(points, spacing = 4.4) {
  if (points.length < 2) return points;
  const output = [points[0]];
  let carry = 0;
  let cursor = points[0];
  for (const next of points.slice(1)) {
    let distance = Math.hypot(next.x - cursor.x, next.y - cursor.y);
    while (carry + distance >= spacing && distance > 0.0001) {
      const ratio = (spacing - carry) / distance;
      cursor = { x: cursor.x + (next.x - cursor.x) * ratio, y: cursor.y + (next.y - cursor.y) * ratio };
      output.push(cursor);
      distance = Math.hypot(next.x - cursor.x, next.y - cursor.y);
      carry = 0;
    }
    carry += distance;
    cursor = next;
  }
  const final = points.at(-1);
  if (final && output.at(-1) !== final) output.push(final);
  return output;
}

function midpointPath(points) {
  if (!points.length) return "";
  if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const point = points[index];
    const midpoint = { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };
    path += ` Q ${previous.x.toFixed(2)} ${previous.y.toFixed(2)} ${midpoint.x.toFixed(2)} ${midpoint.y.toFixed(2)}`;
  }
  const last = points.at(-1);
  if (last) path += ` L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
  return path;
}

function circles(points, color, radius = 2.2) {
  return points.map((point) => `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="${radius}" fill="${color}"/>`).join("");
}

function panel({ title, detail, color, path, points, marker, index }) {
  const visible = points.slice(0, index + 1);
  const visiblePath = midpointPath(visible);
  const tail = visible.at(-1);
  return `
    <section>
      <rect x="34" y="${panel.y}" width="1012" height="144" rx="20" fill="#fffaf1" stroke="#e4d9ca"/>
      <text x="64" y="${panel.y + 38}" class="panel-title" fill="${color}">${title}</text>
      <text x="64" y="${panel.y + 63}" class="panel-detail">${detail}</text>
      <path d="M 64 ${panel.y + 112} H 1016" stroke="#eee4d8" stroke-width="2" stroke-dasharray="3 8"/>
      ${visiblePath ? `<path d="${visiblePath}" transform="translate(0 ${panel.y - 254})" fill="none" stroke="${color}" stroke-width="${panel.width}" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
      ${panel.rawDots ? circles(visible, "#b9aa9b", 2.3).replaceAll("cy=\"", `transform=\"translate(0 ${panel.y - 254})\" cy=\"`) : ""}
      ${tail ? `<circle cx="${tail.x.toFixed(1)}" cy="${(tail.y + panel.y - 254).toFixed(1)}" r="${marker}" fill="#fffaf1" stroke="${color}" stroke-width="3"/>` : ""}
    </section>`;
}

const filtered = oneEuro(raw);
const target = resample(filtered);
const current = raw;

for (let frame = 0; frame < frameCount; frame += 1) {
  const progress = Math.min(frame, raw.length - 1);
  const targetProgress = Math.min(target.length - 1, Math.round((progress / (raw.length - 1)) * (target.length - 1)));
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    text { font-family: ui-monospace, "Cascadia Mono", monospace; }
    .eyebrow { font-size: 15px; font-weight: 700; letter-spacing: .17em; }
    .title { font-size: 31px; font-weight: 700; letter-spacing: -.035em; }
    .copy { font-size: 15px; fill: #6d6258; }
    .panel-title { font-size: 16px; font-weight: 800; letter-spacing: .08em; }
    .panel-detail { font-size: 13px; fill: #766b60; }
    .footer { font-size: 12px; fill: #86786c; }
  </style>
  <rect width="1080" height="640" fill="#f6efe5"/>
  <text x="38" y="42" class="eyebrow" fill="#9a6d37">SIMEIOMA / SKETCH RESEARCH</text>
  <text x="38" y="82" class="title" fill="#2e2923">Target: calm ink, not soft focus</text>
  <text x="38" y="109" class="copy">Same noisy gesture · current midpoint path · proposed adaptive input + spacing + coverage edge</text>
  ${panel({ y: 138, title: "01 / RAW POINTER SAMPLES", detail: "Every event is a visible wobble; no smoothing or spacing control.", color: "#a67c52", path: "", points: raw, marker: 5, width: 3, rawDots: true, index: progress })}
  ${panel({ y: 302, title: "02 / CURRENT SIMEIOMA", detail: "Quadratic midpoints round corners, but preserve sample-rate chatter.", color: "#b75a67", points: current, marker: 5, width: 4, rawDots: false, index: progress })}
  ${panel({ y: 466, title: "03 / ADAPTIVE SIMEIOMA STUDY", detail: "A Simeioma candidate: stable when slow; responsive when fast. Not game-raster evidence.", color: "#2f7c69", points: target, marker: 5.5, width: 6, rawDots: false, index: targetProgress })}
  <text x="38" y="622" class="footer">Research visualisation — reconstructed target behaviour, not Nintendo footage or a claim of its internal implementation.</text>
</svg>`;
  await writeFile(join(frames, `frame-${String(frame).padStart(3, "0")}.svg`), `${svg.replace(/[ \t]+\n/g, "\n").trim()}\n`);
}

await copyFile(join(frames, `frame-${String(frameCount - 1).padStart(3, "0")}.svg`), join(media, "tomodachi-smoothing-comparison.svg"));

await rm(frames, { recursive: true, force: true });
console.log("Generated static SVG research media in", media);
