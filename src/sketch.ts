import type { SketchStrokeRecord } from "./simeiomaModel";

export type SketchPoint = { x: number; y: number };
export type SketchSample = SketchPoint & { time?: number };
export type SmoothSketchOptions = {
  minCutoff: number;
  beta: number;
  derivativeCutoff: number;
  spacing: number;
};
export type SketchStroke = { points: SketchPoint[]; last: SketchPoint; before: ImageData | null };

export const DEFAULT_SMOOTH_SKETCH_OPTIONS: SmoothSketchOptions = {
  minCutoff: 1.35,
  beta: 0.012,
  derivativeCutoff: 1,
  spacing: 4.4,
};

export function smoothSketchPoints(points: SketchSample[], options: SmoothSketchOptions = DEFAULT_SMOOTH_SKETCH_OPTIONS): SketchPoint[] {
  if (points.length < 2) return points.map(({ x, y }) => ({ x, y }));

  const filtered: SketchPoint[] = [{ x: points[0].x, y: points[0].y }];
  let previousTime = points[0].time ?? 0;
  let filteredVelocity = 0;

  for (const point of points.slice(1)) {
    const time = point.time ?? previousTime + 1000 / 60;
    const deltaSeconds = Math.max((time - previousTime) / 1000, 1 / 240);
    const previousRaw = points[filtered.length - 1];
    const rawVelocity = distance(previousRaw, point) / deltaSeconds;
    const derivativeAlpha = smoothingAlpha(options.derivativeCutoff, deltaSeconds);
    filteredVelocity = derivativeAlpha * rawVelocity + (1 - derivativeAlpha) * filteredVelocity;
    const alpha = smoothingAlpha(options.minCutoff + options.beta * filteredVelocity, deltaSeconds);
    const previousFiltered = filtered.at(-1)!;
    filtered.push({
      x: alpha * point.x + (1 - alpha) * previousFiltered.x,
      y: alpha * point.y + (1 - alpha) * previousFiltered.y,
    });
    previousTime = time;
  }

  return resampleSketchPoints(filtered, options.spacing, { x: points.at(-1)!.x, y: points.at(-1)!.y });
}

export function resampleSketchPoints(points: SketchPoint[], spacing: number, finalPoint = points.at(-1)): SketchPoint[] {
  if (points.length < 2 || spacing <= 0) return points.map((point) => ({ ...point }));

  const output = [{ ...points[0] }];
  let previous = points[0];
  let remaining = spacing;

  for (const point of points.slice(1)) {
    let segmentStart = previous;
    let segmentLength = distance(segmentStart, point);
    while (segmentLength >= remaining) {
      const ratio = remaining / segmentLength;
      const next = {
        x: segmentStart.x + (point.x - segmentStart.x) * ratio,
        y: segmentStart.y + (point.y - segmentStart.y) * ratio,
      };
      output.push(next);
      segmentStart = next;
      segmentLength = distance(segmentStart, point);
      remaining = spacing;
    }
    remaining -= segmentLength;
    previous = point;
  }

  if (finalPoint && distance(output.at(-1)!, finalPoint) > 0.001) output.push({ ...finalPoint });
  return output;
}
type SketchShape =
  | { type: "line"; start: SketchPoint; end: SketchPoint }
  | { type: "circle"; center: SketchPoint; radius: number }
  | { type: "rect"; x: number; y: number; width: number; height: number };

export function startSketch(event: PointerEvent, canvas: HTMLCanvasElement | undefined): SketchStroke | null {
  if (!canvas) return null;
  canvas.setPointerCapture(event.pointerId);
  const point = canvasPoint(event, canvas);
  const context = canvas.getContext("2d");
  if (!context) return null;
  const before = context.getImageData(0, 0, canvas.width, canvas.height);
  configureSketchContext(context);
  context.beginPath();
  context.moveTo(point.x, point.y);
  return { points: [point], last: point, before };
}

export function drawSketch(event: PointerEvent, canvas: HTMLCanvasElement, stroke: SketchStroke) {
  const point = canvasPoint(event, canvas);
  stroke.points.push(point);
  const mid = { x: (stroke.last.x + point.x) / 2, y: (stroke.last.y + point.y) / 2 };
  const context = canvas.getContext("2d");
  if (!context) return;
  configureSketchContext(context);
  context.quadraticCurveTo(stroke.last.x, stroke.last.y, mid.x, mid.y);
  context.stroke();
  stroke.last = point;
}

export function finishSketch(canvas: HTMLCanvasElement, stroke: SketchStroke): SketchStrokeRecord {
  const shape = detectSketchShape(stroke.points);
  const record: SketchStrokeRecord = shape ?? { type: "freehand", points: stroke.points };
  const context = canvas.getContext("2d");
  if (!context) return record;
  if (shape && stroke.before) {
    context.putImageData(stroke.before, 0, 0);
    renderSketchRecord(context, record);
  }
  return record;
}

export function renderSketchRecord(context: CanvasRenderingContext2D, record: SketchStrokeRecord) {
  configureSketchContext(context);
  context.beginPath();
  if (record.type === "line") {
    context.moveTo(record.start.x, record.start.y);
    context.lineTo(record.end.x, record.end.y);
  } else if (record.type === "circle") {
    context.arc(record.center.x, record.center.y, record.radius, 0, Math.PI * 2);
  } else if (record.type === "rect") {
    context.rect(record.x, record.y, record.width, record.height);
  } else if (record.points.length) {
    context.moveTo(record.points[0].x, record.points[0].y);
    let last = record.points[0];
    for (const point of record.points.slice(1)) {
      const mid = { x: (last.x + point.x) / 2, y: (last.y + point.y) / 2 };
      context.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
      last = point;
    }
  }
  context.stroke();
}

function detectSketchShape(points: SketchPoint[]): SketchShape | null {
  if (points.length < 4) return null;
  const first = points[0];
  const last = points.at(-1)!;
  const length = strokeLength(points);
  if (length < 18) return null;
  const direct = distance(first, last);
  const bounds = sketchBounds(points);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;

  if (direct / length > 0.88) {
    return { type: "line", start: first, end: last };
  }

  if (width < 14 || height < 14) return null;
  const closed = direct < Math.max(width, height) * 0.28;
  if (!closed || length < Math.max(width, height) * 2.1) return null;

  const center = { x: bounds.minX + width / 2, y: bounds.minY + height / 2 };
  const ratio = width / height;
  if (ratio > 0.72 && ratio < 1.38) {
    return { type: "circle", center, radius: Math.max(width, height) / 2 };
  }
  return { type: "rect", x: bounds.minX, y: bounds.minY, width, height };
}

function configureSketchContext(context: CanvasRenderingContext2D) {
  context.lineWidth = 2;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(35, 31, 25, 0.76)";
}

function strokeLength(points: SketchPoint[]) {
  return points.slice(1).reduce((sum, point, index) => sum + distance(points[index], point), 0);
}

function sketchBounds(points: SketchPoint[]) {
  return points.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

function distance(a: SketchPoint, b: SketchPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function smoothingAlpha(cutoff: number, deltaSeconds: number) {
  const safeCutoff = Math.max(cutoff, 0.001);
  return 1 / (1 + 1 / (2 * Math.PI * safeCutoff * deltaSeconds));
}

function canvasPoint(event: PointerEvent, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}
