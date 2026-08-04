import { describe, expect, test } from "vitest";
import {
  applyMarkdownEdit,
  markdownTokens,
  moveCaretAcrossInlineToken,
  moveCaretToInlineTokenEnd,
  previousGraphemeBoundary,
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

  test("moves one visual step out of inline Markdown wrappers", () => {
    const value = "Before **bold** after ~~done~~";
    expect(moveCaretAcrossInlineToken(value, { start: 13, end: 13 }, "right"))
      .toEqual({ start: 15, end: 15 });
    expect(moveCaretAcrossInlineToken(value, { start: 24, end: 24 }, "left"))
      .toEqual({ start: 22, end: 22 });
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
    expect(moveCaretAcrossInlineToken(value, { start: 3, end: 3 }, "right")).toBeNull();
    expect(moveCaretAcrossInlineToken(value, { start: 2, end: 4 }, "right")).toBeNull();
  });

  test("deletes complete graphemes rather than splitting an emoji sequence", () => {
    const value = "A 👍🏽";
    expect(previousGraphemeBoundary(value, value.length)).toBe(2);
  });
});
