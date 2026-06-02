export type LauncherAnchor = { right: number; bottom: number };
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type WorkArea = { left: number; top: number; right: number; bottom: number; scale: number };
export type WindowRect = Point & Size;

type MonitorLike = {
  scaleFactor: number;
  workArea: {
    position: Point;
    size: Size;
  };
};

export function scaledWorkArea(monitor: MonitorLike): WorkArea {
  const scale = monitor.scaleFactor || 1;
  const work = monitor.workArea;
  return {
    left: work.position.x / scale,
    top: work.position.y / scale,
    right: (work.position.x + work.size.width) / scale,
    bottom: (work.position.y + work.size.height) / scale,
    scale,
  };
}

export function visualCenterForTopRight(work: WorkArea, visual: Size, margin: number) {
  return clampVisualCenter(
    { x: work.right - margin - visual.width / 2, y: work.top + margin + visual.height / 2 },
    work,
    visual,
    margin,
  );
}

export function visualCenterFromAnchor(work: WorkArea, anchor: LauncherAnchor, visual: Size, margin: number) {
  return clampVisualCenter({ x: work.right - anchor.right, y: work.bottom - anchor.bottom }, work, visual, margin);
}

export function windowPositionForVisualCenter(center: Point, windowSize: Size) {
  return { x: center.x - windowSize.width / 2, y: center.y - windowSize.height / 2 };
}

export function launcherAnchorFromWindow(work: WorkArea, windowRect: WindowRect): LauncherAnchor {
  return {
    right: work.right - (windowRect.x + windowRect.width / 2),
    bottom: work.bottom - (windowRect.y + windowRect.height / 2),
  };
}

export function parkingRect(windowRect: WindowRect, visual: Size): WindowRect {
  const x = windowRect.x + (windowRect.width - visual.width) / 2;
  const y = windowRect.y + (windowRect.height - visual.height) / 2;
  return { x, y, width: visual.width, height: visual.height };
}

export function clampParkingDelta(work: WorkArea, parking: WindowRect, margin: number) {
  const allowedLeft = work.left + margin;
  const allowedTop = work.top + margin;
  const allowedRight = work.right - margin;
  const allowedBottom = work.bottom - margin;
  let dx = 0;
  let dy = 0;

  if (parking.x < allowedLeft) dx = allowedLeft - parking.x;
  else if (parking.x + parking.width > allowedRight) dx = allowedRight - (parking.x + parking.width);

  if (parking.y < allowedTop) dy = allowedTop - parking.y;
  else if (parking.y + parking.height > allowedBottom) dy = allowedBottom - (parking.y + parking.height);

  return { dx, dy };
}

function clampVisualCenter(rawCenter: Point, work: WorkArea, visual: Size, margin: number) {
  return {
    x: clamp(rawCenter.x, work.left + margin + visual.width / 2, work.right - margin - visual.width / 2),
    y: clamp(rawCenter.y, work.top + margin + visual.height / 2, work.bottom - margin - visual.height / 2),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
