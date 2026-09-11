import { SPAWN_SCREEN_MARGIN } from "./spawnPlacement";
import { createSignal } from "solid-js";
import { createLauncherConfiguration } from "./launcherConfiguration";
import { recordDiagnostic, beforeDiagnosticResize, recordActualLauncherGeometry, scheduleDiagnosticSnapshot } from "./diagnostics";
import { type LauncherAnchor, scaledWorkArea, type WorkArea, launcherAnchorFromWindow, visualCenterForTopRight, windowPositionForVisualCenter, visualCenterFromAnchor, clampParkingDelta, parkingRect } from "./windowGeometry";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import { readLauncherMonitor } from "./windowSpawning";
import { MENU_WIDTH, MENU_HEIGHT } from "./simeiomaModel";

export const LAUNCHER_CANVAS_WIDTH = 64;

export const LAUNCHER_CANVAS_HEIGHT = 204;

export const LAUNCHER_CONFIRM_CANVAS_WIDTH = 360;

export const LAUNCHER_CONFIRM_CANVAS_HEIGHT = 204;

export const LAUNCHER_IDLE_CANVAS_WIDTH = 30;

export const LAUNCHER_IDLE_CANVAS_HEIGHT = 112;

export const LAUNCHER_SCREEN_MARGIN = SPAWN_SCREEN_MARGIN;

let launcherWasPlaced = false;

export let launcherIsConfiguring = false;

let launcherConfigureRun = 0;

export const [launcherUserDragging, setLauncherUserDragging] = createSignal(false);

export const configureLauncherWindow = createLauncherConfiguration(
  applyLauncherWindowConfiguration,
  (event, request, status) => recordDiagnostic(`configuration-${event}`, {
    ...status, menuOpen: request.menuOpen, confirmingExit: request.confirmingExit,
  }),
);

async function applyLauncherWindowConfiguration(
  { menuOpen, confirmingExit, anchor, setAnchor, setConfirmSide }: {
    menuOpen: boolean;
    confirmingExit: boolean;
    anchor: LauncherAnchor | null;
    setAnchor: (anchor: LauncherAnchor) => void;
    setConfirmSide: (side: "left" | "right") => void;
  },
  operationId: number,
) {
  if (!isTauri() || launcherUserDragging()) return;
  const run = ++launcherConfigureRun;
  launcherIsConfiguring = true;
  const expanded = menuOpen || confirmingExit;
  const width = confirmingExit ? LAUNCHER_CONFIRM_CANVAS_WIDTH : expanded ? LAUNCHER_CANVAS_WIDTH : LAUNCHER_IDLE_CANVAS_WIDTH;
  const height = confirmingExit ? LAUNCHER_CONFIRM_CANVAS_HEIGHT : expanded ? LAUNCHER_CANVAS_HEIGHT : LAUNCHER_IDLE_CANVAS_HEIGHT;
  const parking = launcherParkingSize();
  const appWindow = getCurrentWindow();
  try {
    const work = scaledWorkArea(await readLauncherMonitor());
    const nextAnchor = anchor ?? (launcherWasPlaced ? await readWindowAnchor(work) : null);
    setConfirmSide(!nextAnchor || work.right - nextAnchor.right > (work.left + work.right) / 2 ? "left" : "right");
    await appWindow.setAlwaysOnTop(true);
    await appWindow.setSkipTaskbar(true);
    await appWindow.setResizable(false);
    recordDiagnostic("resize-requested", { operationId, requested: { width, height } });
    await beforeDiagnosticResize(operationId);
    await appWindow.setSize(new LogicalSize(width, height));
    await recordActualLauncherGeometry(operationId);
    if (nextAnchor) {
      await positionLauncherFromAnchor(width, height, parking.width, parking.height, nextAnchor, work);
      if (!confirmingExit) setAnchor(await readWindowAnchor(work));
    } else {
      await positionWindow(width, height, parking.width, parking.height, work);
      setAnchor(await readWindowAnchor(work));
      launcherWasPlaced = true;
    }
  } finally {
    // Transactions are serialized; only this delayed callback can overlap the next one.
    window.setTimeout(() => {
      if (run === launcherConfigureRun) {
        launcherIsConfiguring = false;
        scheduleDiagnosticSnapshot();
      }
    }, 120);
  }
}

export function launcherParkingSize() {
  return { width: MENU_WIDTH, height: MENU_HEIGHT };
}

export async function readWindowAnchor(work?: WorkArea): Promise<LauncherAnchor> {
  work ??= scaledWorkArea(await readLauncherMonitor());
  const position = await getCurrentWindow().outerPosition();
  const size = await getCurrentWindow().outerSize();
  return launcherAnchorFromWindow(work, {
    x: position.x / work.scale,
    y: position.y / work.scale,
    width: size.width / work.scale,
    height: size.height / work.scale,
  });
}

async function positionWindow(width: number, height: number, visualWidth: number, visualHeight: number, work: WorkArea) {
  const center = visualCenterForTopRight(
    work,
    { width: visualWidth, height: visualHeight },
    LAUNCHER_SCREEN_MARGIN,
  );
  const position = windowPositionForVisualCenter(center, { width, height });
  const operationId = configureLauncherWindow.snapshot().operationId;
  recordDiagnostic("position-requested", { operationId, requested: position });
  await getCurrentWindow().setPosition(new PhysicalPosition(Math.round(position.x * work.scale), Math.round(position.y * work.scale)));
  await recordActualLauncherGeometry(operationId, "position-completed");
}

async function positionLauncherFromAnchor(
  width: number,
  height: number,
  visualWidth: number,
  visualHeight: number,
  anchor: LauncherAnchor,
  work: WorkArea,
) {
  const center = visualCenterFromAnchor(
    work,
    anchor,
    { width: visualWidth, height: visualHeight },
    LAUNCHER_SCREEN_MARGIN,
  );
  const position = windowPositionForVisualCenter(center, { width, height });
  const operationId = configureLauncherWindow.snapshot().operationId;
  recordDiagnostic("position-requested", { operationId, requested: position });
  await getCurrentWindow().setPosition(new PhysicalPosition(Math.round(position.x * work.scale), Math.round(position.y * work.scale)));
  await recordActualLauncherGeometry(operationId, "position-completed");
}

export async function clampCurrentLauncherToWorkArea(visualWidth: number, visualHeight: number, margin: number) {
  if (!isTauri()) return false;
  const work = scaledWorkArea(await readLauncherMonitor());
  const position = await getCurrentWindow().outerPosition();
  const size = await getCurrentWindow().outerSize();
  const windowRect = {
    x: position.x / work.scale,
    y: position.y / work.scale,
    width: size.width / work.scale,
    height: size.height / work.scale,
  };
  const { dx, dy } = clampParkingDelta(work, parkingRect(windowRect, { width: visualWidth, height: visualHeight }), margin);

  if (Math.abs(dx) <= 0.5 && Math.abs(dy) <= 0.5) return false;
  const requested = { x: windowRect.x + dx, y: windowRect.y + dy };
  recordDiagnostic("position-requested", { operationId: 0, clamping: true, requested });
  await getCurrentWindow().setPosition(new PhysicalPosition(Math.round(requested.x * work.scale), Math.round(requested.y * work.scale)));
  await recordActualLauncherGeometry(0, "position-completed");
  return true;
}
