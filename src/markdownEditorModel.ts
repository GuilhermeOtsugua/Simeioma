export type SourceSelection = { start: number; end: number };

export type MarkdownToken =
  | { type: "bold" | "italic" | "strike" | "code"; from: number; to: number; contentFrom: number; contentTo: number; text: string }
  | { type: "link"; from: number; to: number; contentFrom: number; contentTo: number; text: string; href: string };

export function markdownTokens(value: string, offset = 0): MarkdownToken[] {
  const tokens: MarkdownToken[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const token = nextMarkdownToken(value, cursor, offset);
    if (!token) {
      cursor += 1;
      continue;
    }
    tokens.push(token);
    cursor = token.to - offset;
  }

  return tokens;
}

export function moveCaretIntoInlineToken(
  value: string,
  selection: SourceSelection,
  direction: "left" | "right",
): SourceSelection | null {
  if (selection.start !== selection.end) return null;
  const caret = selection.start;
  for (const token of markdownTokens(value)) {
    if (direction === "right" && (caret === token.from || caret === token.contentFrom)) {
      return { start: token.from, end: token.from };
    }
    if (direction === "left" && (caret === token.to || caret === token.contentTo)) {
      return { start: token.to, end: token.to };
    }
  }
  return null;
}

export function moveCaretAcrossInlineToken(
  value: string,
  selection: SourceSelection,
  direction: "left" | "right",
): SourceSelection | null {
  if (selection.start !== selection.end) return null;
  const caret = selection.start;
  for (const token of markdownTokens(value)) {
    if (direction === "right" && caret === token.contentTo) return { start: token.to, end: token.to };
    if (direction === "left" && caret === token.contentFrom) return { start: token.from, end: token.from };
  }
  return null;
}

export function applyMarkdownEdit(value: string, selection: SourceSelection, insertedText: string) {
  const range = normalizeSelection(value, selection);
  const next = `${value.slice(0, range.start)}${insertedText}${value.slice(range.end)}`;
  const caret = range.start + insertedText.length;
  return { value: next, selection: { start: caret, end: caret } };
}

export function toggleStrikethrough(value: string, selection: SourceSelection) {
  const range = normalizeSelection(value, selection);
  const target = range.start === range.end ? wordRangeAt(value, range.start) ?? range : range;
  const struck = markdownTokens(value).find((token) =>
    token.type === "strike" && target.start >= token.from && target.end <= token.to,
  );
  if (struck) {
    const unwrappedSelection = range.start === range.end ? range : target;
    const start = struck.from + Math.max(0, Math.min(unwrappedSelection.start - struck.contentFrom, struck.text.length));
    const end = struck.from + Math.max(0, Math.min(unwrappedSelection.end - struck.contentFrom, struck.text.length));
    return {
      value: `${value.slice(0, struck.from)}${struck.text}${value.slice(struck.to)}`,
      selection: { start, end },
    };
  }
  return wrapSelectionWithStrikethrough(value, target);
}

export function wrapSelectionWithStrikethrough(value: string, selection: SourceSelection) {
  const range = normalizeSelection(value, selection);
  if (range.start === range.end) {
    return {
      value: `${value.slice(0, range.start)}~~~~${value.slice(range.end)}`,
      selection: { start: range.start + 4, end: range.start + 4 },
    };
  }

  const selected = value.slice(range.start, range.end);
  const caret = range.end + 4;
  return {
    value: `${value.slice(0, range.start)}~~${selected}~~${value.slice(range.end)}`,
    selection: { start: caret, end: caret },
  };
}

export function previousGraphemeBoundary(value: string, offset: number) {
  const safeOffset = Math.max(0, Math.min(offset, value.length));
  if (safeOffset === 0) return 0;
  if (typeof Intl.Segmenter !== "undefined") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let previous = 0;
    for (const item of segmenter.segment(value)) {
      if (item.index >= safeOffset) return previous;
      previous = item.index;
    }
    return previous;
  }
  const codePoint = value.codePointAt(safeOffset - 1);
  return safeOffset - (codePoint && codePoint > 0xffff ? 2 : 1);
}

export function nextGraphemeBoundary(value: string, offset: number) {
  const safeOffset = Math.max(0, Math.min(offset, value.length));
  if (safeOffset === value.length) return value.length;
  if (typeof Intl.Segmenter !== "undefined") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const item of segmenter.segment(value)) {
      if (item.index > safeOffset) return item.index;
    }
    return value.length;
  }
  const codePoint = value.codePointAt(safeOffset);
  return safeOffset + (codePoint && codePoint > 0xffff ? 2 : 1);
}

function nextMarkdownToken(value: string, cursor: number, offset: number): MarkdownToken | null {
  const link = value.slice(cursor).match(/^\[([^\]\n]+)\]\(([^\s)]+)\)/);
  if (link) {
    const text = link[1];
    const href = link[2];
    const from = cursor + offset;
    return {
      type: "link",
      from,
      to: from + link[0].length,
      contentFrom: from + 1,
      contentTo: from + 1 + text.length,
      text,
      href,
    };
  }

  const paired = pairedToken(value, cursor, "`", "code", offset)
    ?? pairedToken(value, cursor, "**", "bold", offset)
    ?? pairedToken(value, cursor, "~~", "strike", offset)
    ?? pairedToken(value, cursor, "*", "italic", offset);
  return paired;
}

function pairedToken(
  value: string,
  cursor: number,
  delimiter: "`" | "**" | "~~" | "*",
  type: "code" | "bold" | "strike" | "italic",
  offset: number,
): MarkdownToken | null {
  if (!value.startsWith(delimiter, cursor)) return null;
  if (delimiter === "*" && value.startsWith("**", cursor)) return null;
  const contentFrom = cursor + delimiter.length;
  const end = value.indexOf(delimiter, contentFrom);
  if (end < contentFrom + 1 || end === -1 || value.slice(contentFrom, end).includes("\n")) return null;
  const from = cursor + offset;
  return {
    type,
    from,
    to: end + delimiter.length + offset,
    contentFrom: contentFrom + offset,
    contentTo: end + offset,
    text: value.slice(contentFrom, end),
  };
}

function wordRangeAt(value: string, offset: number): SourceSelection | null {
  const safeOffset = Math.max(0, Math.min(offset, value.length));
  if (typeof Intl.Segmenter !== "undefined") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    for (const item of segmenter.segment(value)) {
      const end = item.index + item.segment.length;
      if (item.isWordLike && safeOffset >= item.index && safeOffset <= end) {
        return { start: item.index, end };
      }
    }
  }

  const match = /[\p{L}\p{N}_]+/gu;
  for (const item of value.matchAll(match)) {
    const start = item.index ?? 0;
    const end = start + item[0].length;
    if (safeOffset >= start && safeOffset <= end) return { start, end };
  }
  return null;
}

function normalizeSelection(value: string, selection: SourceSelection): SourceSelection {
  const start = Math.max(0, Math.min(selection.start, value.length));
  const end = Math.max(start, Math.min(selection.end, value.length));
  return { start, end };
}
