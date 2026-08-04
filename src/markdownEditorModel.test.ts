import { describe, expect, test } from "vitest";
import {
  applyMarkdownEdit,
  markdownTokens,
  moveCaretIntoInlineToken,
  moveCaretToInlineTokenEnd,
  previousGraphemeBoundary,
  toggleStrikethrough,
  wrapSelectionWithStrikethrough,
} from "./markdownEditorModel";

describe("Markdown editor model", () => {
  test("finds non-overlapping inline Markdown source ranges", () => {
    expect(markdownTokens("Keep **bold**, *soft*, ~~done~~, `code`, and [site](https://example.com)."))
      .toEqual([
        { type: "bold", from: 5, to: 13, contentFrom: 7, contentTo: 11, text: "bold" },
        { type: "italic", from: 15, to: 21, contentFrom: 16, contentTo: 20, text: "soft" },
        { type: "strike", from: 23, to: 31, contentFrom: 25, contentTo: 29, text: "done" },
        { type: "code", from: 33, to: 39, contentFrom: 34, contentTo: 38, text: "code" },
        { type: "link", from: 45, to: 72, contentFrom: 46, contentTo: 50, text: "site", href: "https://example.com" },
      ]);
  });

  test("leaves incomplete syntax as ordinary source", () => {
    expect(markdownTokens("**unfinished and ~~also"))
      .toEqual([]);
  });

  test("replaces the selected source range and positions the caret after inserted text", () => {
    expect(applyMarkdownEdit("A small note", { start: 2, end: 7 }, "bright"))
      .toEqual({ value: "A bright note", selection: { start: 8, end: 8 } });
  });

  test("wraps selected text in source strikethrough markers", () => {
    expect(wrapSelectionWithStrikethrough("Plan lunch", { start: 5, end: 10 }))
      .toEqual({ value: "Plan ~~lunch~~", selection: { start: 7, end: 12 } });
  });

  test("inserts empty strikethrough markers when no text is selected", () => {
    expect(wrapSelectionWithStrikethrough("Plan", { start: 4, end: 4 }))
      .toEqual({ value: "Plan~~~~", selection: { start: 6, end: 6 } });
  });

  test("wraps the word under a collapsed strikethrough command", () => {
    expect(toggleStrikethrough("Plan lunch", { start: 7, end: 7 }))
      .toEqual({ value: "Plan ~~lunch~~", selection: { start: 7, end: 12 } });
  });

  test("wraps a selected range and toggles an existing strikethrough wrapper off", () => {
    expect(toggleStrikethrough("Plan lunch", { start: 5, end: 10 }))
      .toEqual({ value: "Plan ~~lunch~~", selection: { start: 7, end: 12 } });
    expect(toggleStrikethrough("Plan ~~lunch~~", { start: 7, end: 12 }))
      .toEqual({ value: "Plan lunch", selection: { start: 5, end: 10 } });
  });

  test("unwraps the current struck term from a collapsed caret", () => {
    expect(toggleStrikethrough("Plan ~~lunch~~", { start: 9, end: 9 }))
      .toEqual({ value: "Plan lunch", selection: { start: 7, end: 7 } });
  });

  test("only changes the targeted term when multiple strikethrough tokens exist", () => {
    expect(toggleStrikethrough("~~alpha~~ beta", { start: 12, end: 12 }))
      .toEqual({ value: "~~alpha~~ ~~beta~~", selection: { start: 12, end: 16 } });
    expect(toggleStrikethrough("~~alpha~~ ~~beta~~", { start: 3, end: 3 }))
      .toEqual({ value: "alpha ~~beta~~", selection: { start: 1, end: 1 } });
  });

  test("surfaces inline Markdown wrappers at their approached boundary", () => {
    const value = "Before **bold** after";
    expect(moveCaretIntoInlineToken(value, { start: 7, end: 7 }, "right"))
      .toEqual({ start: 7, end: 7 });
    expect(moveCaretIntoInlineToken(value, { start: 9, end: 9 }, "right"))
      .toEqual({ start: 7, end: 7 });
    expect(moveCaretIntoInlineToken(value, { start: 15, end: 15 }, "left"))
      .toEqual({ start: 15, end: 15 });
    expect(moveCaretIntoInlineToken(value, { start: 13, end: 13 }, "left"))
      .toEqual({ start: 15, end: 15 });
  });

  test("moves a returning caret to the end of its inline wrapper", () => {
    const value = "Before **bold** after";
    expect(moveCaretToInlineTokenEnd(value, { start: 11, end: 11 }))
      .toEqual({ start: 15, end: 15 });
    expect(moveCaretToInlineTokenEnd(value, { start: 7, end: 10 }))
      .toEqual({ start: 7, end: 10 });
  });

  test("does not hijack non-boundary or range selection navigation", () => {
    const value = "**bold**";
    expect(moveCaretIntoInlineToken(value, { start: 3, end: 3 }, "right")).toBeNull();
    expect(moveCaretIntoInlineToken(value, { start: 2, end: 4 }, "right")).toBeNull();
  });

  test("deletes complete graphemes rather than splitting an emoji sequence", () => {
    const value = "A 👍🏽";
    expect(previousGraphemeBoundary(value, value.length)).toBe(2);
  });
});
