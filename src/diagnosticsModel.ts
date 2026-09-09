import type { AppState } from "./simeiomaModel";

export type DiagnosticRect = { x: number; y: number; width: number; height: number };

export function isRectClipped(rect: DiagnosticRect, bounds: DiagnosticRect) {
  const tolerance = 1; // Ignore subpixel rounding, not visibly missing content.
  return rect.x < bounds.x - tolerance || rect.y < bounds.y - tolerance
    || rect.x + rect.width > bounds.x + bounds.width + tolerance
    || rect.y + rect.height > bounds.y + bounds.height + tolerance;
}

type AnomalyInput = {
  busy: boolean; operationId: number; operationAgeMs: number;
  dragging: boolean; settled: boolean; clipped: boolean; mismatch: string;
};

export function createAnomalyDetector() {
  let stalledOperation: number | undefined;
  let mismatch = "";
  let mismatchSince = 0;
  let reportedMismatch = "";
  return {
    check(input: AnomalyInput, now: number): ("queue-stalled" | "geometry-mismatch")[] {
      const events: ("queue-stalled" | "geometry-mismatch")[] = [];
      if (!input.busy) stalledOperation = undefined;
      if (input.busy && !input.dragging && input.operationAgeMs >= 5000 && stalledOperation !== input.operationId) {
        events.push("queue-stalled");
        stalledOperation = input.operationId;
      }
      const signature = input.settled && !input.dragging && !input.busy ? input.mismatch : "";
      if (signature !== mismatch) { mismatchSince = now; mismatch = signature; reportedMismatch = ""; }
      if (signature && signature !== reportedMismatch && (input.clipped || now - mismatchSince >= 1000)) {
        events.push("geometry-mismatch");
        reportedMismatch = signature;
      }
      return events;
    },
  };
}

export function diagnosticStorage(nativeDebug: boolean, clean: boolean) {
  return nativeDebug && clean ? "simeioma:debug-clean:v1" : "simeioma:v1";
}

export function summarizeDiagnosticState(state: AppState, revision: number) {
  return {
    revision,
    noteCount: state.notes.length,
    importantCount: state.notes.filter((note) => note.important).length,
    taskCount: state.notes.reduce((count, note) => count + note.lines.filter((line) => line.task && !line.crossed).length, 0),
  };
}
