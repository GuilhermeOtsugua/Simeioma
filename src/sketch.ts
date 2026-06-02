import type { SketchStrokeRecord } from "./simeiomaModel";

export type SketchPoint = { x: number; y: number };
export type SketchStroke = { points: SketchPoint[]; last: SketchPoint; before: ImageData | null };
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

function canvasPoint(event: PointerEvent, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}
