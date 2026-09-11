import { expect, it } from "vitest";
import { decodeState, encodeState } from "./stateCodec";
import { createInitialState, createNoteInState } from "./simeiomaModel";

it("round trips legacy state without losing content or edge geometry", () => {
  const original = createNoteInState(createInitialState(2), { id: "a", lineId: "l", now: "2026-09-09T12:00:00Z", origin: { x: -40, y: 950 } }).state;
  expect(decodeState(JSON.stringify(original))).toEqual(original);
  expect(decodeState(encodeState(original))).toEqual(original);
});
it.each(['{', '{"notes":[{}]}', '{"notes":null}', '{"schemaVersion":99,"notes":[]}', '{"settings":{"exportPath":22}}'])('rejects invalid state instead of returning an empty session: %s', raw => {
  expect(() => decodeState(raw)).toThrow();
});
