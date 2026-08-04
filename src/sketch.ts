import type { SketchBrushSize, SketchRenderingMode, SketchStrokeRecord } from "./simeiomaModel";

export const SKETCH_LOGICAL_SIZE = 384;
export type SketchPoint = { x: number; y: number };
export type SketchSample = SketchPoint & { time?: number };
export type SmoothSketchOptions = {
  minCutoff: number;
  beta: number;
  derivativeCutoff: number;
  spacing: number;
};
export type SketchStroke = {
  points: SketchSample[];
  last: SketchPoint;
  before: ImageData | null;
  renderingMode: SketchRenderingMode;
  brushSize: SketchBrushSize;
};

export const DEFAULT_SMOOTH_SKETCH_OPTIONS: SmoothSketchOptions = {
  minCutoff: 1.35,
  beta: 0.012,
  derivativeCutoff: 1,
  spacing: 2.2,
};

export function sketchCanvasBackingSize(size: { width: number; height: number }, pixelRatio: number) {
  const safeRatio = Math.max(pixelRatio, 1);
  return {
    width: Math.max(1, Math.round(size.width * safeRatio)),
    height: Math.max(1, Math.round(size.height * safeRatio)),
  };
}

export function sketchBrushWidth(size: SketchBrushSize) {
  return { thin: 1, default: 2, thick: 4 }[size];
}

export function smoothSketchPoints(points: SketchSample[], options: SmoothSketchOptions = DEFAULT_SMOOTH_SKETCH_OPTIONS): SketchPoint[] {
  if (points.length < 2) return points.map(({ x, y }) => ({ x, y }));

  const filtered: SketchPoint[] = [{ x: points[0].x, y: points[0].y }];
  let previousTime = points[0].time ?? 0;
  let derivativeX = 0;
  let derivativeY = 0;

  for (const point of points.slice(1)) {
    const time = point.time ?? previousTime + 1000 / 60;
    const deltaSeconds = Math.max((time - previousTime) / 1000, 1 / 240);
    const previousFiltered = filtered.at(-1)!;
    const derivativeAlpha = smoothingAlpha(options.derivativeCutoff, deltaSeconds);
    derivativeX = derivativeAlpha * ((point.x - previousFiltered.x) / deltaSeconds) + (1 - derivativeAlpha) * derivativeX;
    derivativeY = derivativeAlpha * ((point.y - previousFiltered.y) / deltaSeconds) + (1 - derivativeAlpha) * derivativeY;
    const speed = Math.hypot(derivativeX, derivativeY);
    const alpha = smoothingAlpha(options.minCutoff + options.beta * speed, deltaSeconds);
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

export function prepareSketchCanvas(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  const size = sketchCanvasBackingSize(
    {
      width: rect.width || SKETCH_LOGICAL_SIZE,
      height: rect.height || SKETCH_LOGICAL_SIZE,
    },
    Math.max(window.devicePixelRatio || 1, 1),
  );
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width;
    canvas.height = size.height;
  }
  const context = canvas.getContext("2d");
  if (context) configureSketchContext(context);
  return context;
}

export function clearSketchCanvas(context: CanvasRenderingContext2D) {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  context.restore();
}

export function coalescedPointerEvents(event: PointerEvent) {
  const samples = event.getCoalescedEvents?.();
  return samples?.length ? [...samples] : [event];
}

export function startSketch(
  event: PointerEvent,
  canvas: HTMLCanvasElement | undefined,
  renderingMode: SketchRenderingMode = "legacy",
  brushSize: SketchBrushSize = "default",
): SketchStroke | null {
  if (!canvas) return null;
  canvas.setPointerCapture(event.pointerId);
  const point = canvasSample(event, canvas);
  const context = prepareSketchCanvas(canvas);
  if (!context) return null;
  const before = context.getImageData(0, 0, canvas.width, canvas.height);
  if (renderingMode === "legacy") {
    configureSketchContext(context, brushSize);
    context.beginPath();
    const canvasPoint = toCanvasPoint(context.canvas, point);
    context.moveTo(canvasPoint.x, canvasPoint.y);
  }
  return { points: [point], last: point, before, renderingMode, brushSize };
}

export function drawSketch(event: PointerEvent, canvas: HTMLCanvasElement, stroke: SketchStroke) {
  const point = canvasSample(event, canvas);
  const previous = stroke.points.at(-1);
  if (previous && previous.x === point.x && previous.y === point.y && previous.time === point.time) return;
  stroke.points.push(point);
  const context = prepareSketchCanvas(canvas);
  if (!context) return;

  if (stroke.renderingMode === "legacy") {
    configureSketchContext(context, stroke.brushSize);
    const mid = { x: (stroke.last.x + point.x) / 2, y: (stroke.last.y + point.y) / 2 };
    const canvasLast = toCanvasPoint(context.canvas, stroke.last);
    const canvasMid = toCanvasPoint(context.canvas, mid);
    context.quadraticCurveTo(canvasLast.x, canvasLast.y, canvasMid.x, canvasMid.y);
    context.stroke();
    stroke.last = point;
    return;
  }

  if (stroke.before) context.putImageData(stroke.before, 0, 0);
  renderFreehand(context, stroke.points, stroke.renderingMode, stroke.brushSize);
  stroke.last = point;
}

export function recordSketchStroke(stroke: Pick<SketchStroke, "points" | "renderingMode" | "brushSize">): Extract<SketchStrokeRecord, { type: "freehand" }> {
  return {
    type: "freehand",
    points: stroke.points.map((point) => ({ ...point })),
    renderingMode: stroke.renderingMode,
    brushSize: stroke.brushSize,
  };
}

export function finishSketch(canvas: HTMLCanvasElement, stroke: SketchStroke): SketchStrokeRecord {
  prepareSketchCanvas(canvas);
  return recordSketchStroke(stroke);
}

export function resolveSketchRenderingMode(record: Extract<SketchStrokeRecord, { type: "freehand" }>): SketchRenderingMode {
  return record.renderingMode ?? "legacy";
}

export function resolveSketchBrushSize(record: Extract<SketchStrokeRecord, { type: "freehand" }>): SketchBrushSize {
  return record.brushSize ?? "default";
}

export function renderSketchRecord(context: CanvasRenderingContext2D, record: SketchStrokeRecord) {
  if (record.type === "freehand") {
    renderFreehand(context, record.points, resolveSketchRenderingMode(record), resolveSketchBrushSize(record));
    return;
  }

  configureSketchContext(context);
  context.beginPath();
  if (record.type === "line") {
    const start = toCanvasPoint(context.canvas, record.start);
    const end = toCanvasPoint(context.canvas, record.end);
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
  } else if (record.type === "circle") {
    const center = toCanvasPoint(context.canvas, record.center);
    const scale = canvasScale(context.canvas);
    context.ellipse(center.x, center.y, record.radius * scale.x, record.radius * scale.y, 0, 0, Math.PI * 2);
  } else {
    const origin = toCanvasPoint(context.canvas, { x: record.x, y: record.y });
    const scale = canvasScale(context.canvas);
    context.rect(origin.x, origin.y, record.width * scale.x, record.height * scale.y);
  }
  context.stroke();
}

function renderFreehand(context: CanvasRenderingContext2D, points: SketchSample[], mode: SketchRenderingMode, brushSize: SketchBrushSize) {
  if (!points.length) return;
  if (mode === "legacy") {
    configureSketchContext(context, brushSize);
    context.beginPath();
    const first = toCanvasPoint(context.canvas, points[0]);
    context.moveTo(first.x, first.y);
    let last = points[0];
    for (const point of points.slice(1)) {
      const mid = { x: (last.x + point.x) / 2, y: (last.y + point.y) / 2 };
      const canvasLast = toCanvasPoint(context.canvas, last);
      const canvasMid = toCanvasPoint(context.canvas, mid);
      context.quadraticCurveTo(canvasLast.x, canvasLast.y, canvasMid.x, canvasMid.y);
      last = point;
    }
    context.stroke();
    return;
  }

  const displayPoints = smoothSketchPoints(points);
  if (mode === "tomodachi-pixel") {
    renderPixelStroke(context, displayPoints, brushSize);
    return;
  }

  configureSketchContext(context, brushSize);
  context.beginPath();
  const first = toCanvasPoint(context.canvas, displayPoints[0]);
  context.moveTo(first.x, first.y);
  for (const point of displayPoints.slice(1)) {
    const canvasPoint = toCanvasPoint(context.canvas, point);
    context.lineTo(canvasPoint.x, canvasPoint.y);
  }
  context.stroke();
}

function renderPixelStroke(context: CanvasRenderingContext2D, points: SketchPoint[], brushSize: SketchBrushSize) {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = "rgb(35, 31, 25)";
  const dabSize = Math.max(1, Math.round(sketchBrushWidth(brushSize) * canvasPixelRatio(context.canvas)));
  drawPixelDab(context, toCanvasPoint(context.canvas, points[0]), dabSize);
  for (let index = 1; index < points.length; index += 1) {
    const previous = toCanvasPoint(context.canvas, points[index - 1]);
    const point = toCanvasPoint(context.canvas, points[index]);
    const steps = Math.max(1, Math.ceil(distance(previous, point)));
    for (let step = 1; step <= steps; step += 1) {
      const ratio = step / steps;
      drawPixelDab(context, {
        x: previous.x + (point.x - previous.x) * ratio,
        y: previous.y + (point.y - previous.y) * ratio,
      }, dabSize);
    }
  }
  context.restore();
}

function drawPixelDab(context: CanvasRenderingContext2D, point: SketchPoint, size: number) {
  const offset = Math.floor(size / 2);
  context.fillRect(Math.round(point.x) - offset, Math.round(point.y) - offset, size, size);
}

function configureSketchContext(context: CanvasRenderingContext2D, brushSize: SketchBrushSize = "default") {
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.lineWidth = sketchBrushWidth(brushSize) * canvasPixelRatio(context.canvas);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "rgba(35, 31, 25, 0.76)";
}

function canvasScale(canvas: HTMLCanvasElement) {
  return {
    x: canvas.width / SKETCH_LOGICAL_SIZE,
    y: canvas.height / SKETCH_LOGICAL_SIZE,
  };
}

function canvasPixelRatio(canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return rect.width > 0 ? canvas.width / rect.width : Math.max(window.devicePixelRatio || 1, 1);
}

function toCanvasPoint(canvas: HTMLCanvasElement, point: SketchPoint): SketchPoint {
  const scale = canvasScale(canvas);
  return { x: point.x * scale.x, y: point.y * scale.y };
}

function distance(a: SketchPoint, b: SketchPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function smoothingAlpha(cutoff: number, deltaSeconds: number) {
  const safeCutoff = Math.max(cutoff, 0.001);
  return 1 / (1 + 1 / (2 * Math.PI * safeCutoff * deltaSeconds));
}

function canvasSample(event: PointerEvent, canvas: HTMLCanvasElement): SketchSample {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * SKETCH_LOGICAL_SIZE,
    y: ((event.clientY - rect.top) / rect.height) * SKETCH_LOGICAL_SIZE,
    time: event.timeStamp,
  };
}
