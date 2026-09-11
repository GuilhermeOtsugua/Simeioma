import type { SketchBrushSize, SketchStrokeRecord } from "./simeiomaModel";
import { smoothSketchPoints, resolveSketchBrushSize, resolveSketchRenderingMode, renderPixelStroke, sketchBrushWidth, SKETCH_LOGICAL_SIZE, type SketchPoint } from "./sketch";

type Geometry = { path: Path2D; brush: SketchBrushSize } | { pixels: SketchPoint[]; brush: SketchBrushSize };
export function compileSketchStroke(record: SketchStrokeRecord): Geometry {
  const path = new Path2D();
  if (record.type === "freehand") {
    const brush = resolveSketchBrushSize(record), mode = resolveSketchRenderingMode(record);
    const points = mode === "legacy" ? record.points : smoothSketchPoints(record.points);
    if (mode === "tomodachi-pixel") return { pixels: points, brush };
    if (points.length) {
      path.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        const previous = points[i - 1], point = points[i];
        if (mode === "legacy") path.quadraticCurveTo(previous.x, previous.y, (previous.x + point.x) / 2, (previous.y + point.y) / 2);
        else path.lineTo(point.x, point.y);
      }
    }
    return { path, brush };
  }
  if (record.type === "line") { path.moveTo(record.start.x, record.start.y); path.lineTo(record.end.x, record.end.y); }
  else if (record.type === "circle") path.arc(record.center.x, record.center.y, record.radius, 0, Math.PI * 2);
  else path.rect(record.x, record.y, record.width, record.height);
  return { path, brush: "default" };
}

// Cache only the current scene. Fingerprints are computed on content updates, never on resize.
export function createSketchScene(compile = compileSketchStroke) {
  let cache = new Map<string, Geometry>(), keys: string[] = [], geometries: Geometry[] = [];
  let previous: SketchStrokeRecord[] = [];
  const fingerprints = new WeakMap<SketchStrokeRecord, string>();
  const fingerprint = (stroke: SketchStrokeRecord) => {
    const cached = fingerprints.get(stroke);
    if (cached !== undefined) return cached;
    const geometry = stroke.type === "freehand"
      ? [stroke.type, stroke.points.map(point => [point.x, point.y, point.time]), resolveSketchRenderingMode(stroke), resolveSketchBrushSize(stroke)]
      : stroke.type === "line" ? [stroke.type, stroke.start.x, stroke.start.y, stroke.end.x, stroke.end.y]
      : stroke.type === "circle" ? [stroke.type, stroke.center.x, stroke.center.y, stroke.radius]
      : [stroke.type, stroke.x, stroke.y, stroke.width, stroke.height];
    const key = JSON.stringify(geometry); fingerprints.set(stroke, key); return key;
  };
  return {
    setStrokes(strokes: SketchStrokeRecord[]) {
      if (strokes.length === previous.length && strokes.every((stroke, i) => stroke === previous[i])) return false;
      const nextKeys = strokes.map(fingerprint);
      const changed = nextKeys.length !== keys.length || nextKeys.some((key, i) => key !== keys[i]);
      previous = strokes;
      if (!changed) return false;
      const next = new Map<string, Geometry>();
      geometries = strokes.map((stroke, i) => {
        const key = nextKeys[i], geometry = next.get(key) ?? cache.get(key) ?? compile(stroke);
        next.set(key, geometry); return geometry;
      });
      cache = next; keys = nextKeys; return true;
    },
    draw(context: CanvasRenderingContext2D) {
      const canvas = context.canvas, rect = canvas.getBoundingClientRect();
      const ratio = rect.width > 0 ? canvas.width / rect.width : Math.max(window.devicePixelRatio || 1, 1);
      const transform = new DOMMatrix([canvas.width / SKETCH_LOGICAL_SIZE, 0, 0, canvas.height / SKETCH_LOGICAL_SIZE, 0, 0]);
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.lineCap = "round"; context.lineJoin = "round"; context.strokeStyle = "rgba(35, 31, 25, 0.76)";
      for (const geometry of geometries) {
        if ("pixels" in geometry) {
          if (geometry.pixels.length) renderPixelStroke(context, geometry.pixels, geometry.brush, ratio);
        } else {
          // Transform the path, not the context: keep brush width stable under non-uniform resizing.
          const scaled = new Path2D(); scaled.addPath(geometry.path, transform);
          context.lineWidth = sketchBrushWidth(geometry.brush) * ratio; context.stroke(scaled);
        }
      }
    },
  };
}
