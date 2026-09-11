import { expect, it } from "vitest";
import { commitComposition } from "./composition";
it("changes only the composition range, preserving unrelated Markdown", () => {
  const value = "# Heading\n**bold**\nedit";
  const range = { start: value.length, end: value.length };
  expect(commitComposition(value, range, value + "日本語")?.value).toBe(value + "日本語");
  expect(commitComposition(value, range, "Heading\nbold\nedit日本語")).toBeNull();
});
it("supports replacement, multiline input and cancellation", () => {
  expect(commitComposition("abcXYZdef", { start: 3, end: 6 }, "abc日\n本def")?.value).toBe("abc日\n本def");
  expect(commitComposition("abc", { start: 1, end: 2 }, "abc")?.value).toBe("abc");
});
