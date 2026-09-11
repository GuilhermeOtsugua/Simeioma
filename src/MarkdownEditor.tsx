import { createEffect, onCleanup, onMount, type JSX } from "solid-js";
import { sourceLines, taskLine } from "./noteContent";
import {
  applyMarkdownEdit,
  markdownTokens,
  moveCaretIntoInlineToken,
  nextGraphemeBoundary,
  previousGraphemeBoundary,
  toggleStrikethrough,
  type MarkdownToken,
  type SourceSelection,
} from "./markdownEditorModel";

export type MarkdownEditorHandle = {
  element: HTMLDivElement;
  focus: () => void;
  selection: () => SourceSelection;
  setSelection: (selection: SourceSelection) => void;
  selectAll: () => void;
  replaceSelection: (text: string) => void;
  cutSelection: () => string;
  copySelection: () => string;
  setDirection: (direction: "ltr" | "rtl") => void;
  collapseToEnd: () => void;
  wrapSelectionWithStrikethrough: () => void;
  setValue: (value: string) => void;
};

type MarkdownEditorProps = {
  value: string;
  label: string;
  placeholder: string;
  onValue: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onChange?: () => void;
  onLayoutChange?: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  onPointerDown?: (event: PointerEvent) => void;
  ref?: (handle: MarkdownEditorHandle) => void;
};

type HistoryEntry = { value: string; selection: SourceSelection };
type SourceLine = ReturnType<typeof sourceLines>[number];

export function MarkdownEditor(props: MarkdownEditorProps) {
  let element!: HTMLDivElement;
  let source = props.value;
  let selection: SourceSelection = { start: source.length, end: source.length };
  let composing = false;
  let isFocused = false;
  let pendingStrikeSelection: SourceSelection | null = null;
  let revealedTokenFrom: number | null = null;
  let pendingArrowDirection: "left" | "right" | null = null;
  let compositionHistoryRecorded = false;
  let renderedSource = "";
  let renderedSelection = "";
  let activeTokenStarts = new Set<number>();
  let activeLineIndexes = new Set<number>();
  let undoStack: HistoryEntry[] = [];
  let redoStack: HistoryEntry[] = [];
  let lastEmittedValue = source;

  const lines = () => sourceLines(source);

  const notify = () => {
    lastEmittedValue = source;
    props.onValue(source);
    props.onChange?.();
  };

  const render = (restoreSelection = true, forceInactive = false) => {
    if (!element || composing) return;
    refreshPresentationForSelection(forceInactive);
    const selectionKey = `${selection.start}:${selection.end}:${[...activeTokenStarts].join(",")}:${[...activeLineIndexes].join(",")}`;
    if (renderedSource === source && renderedSelection === selectionKey) return;

    const fragment = document.createDocumentFragment();
    if (source) {
      for (const line of lines()) fragment.appendChild(renderLine(line));
    }
    element.replaceChildren(fragment);
    renderedSource = source;
    renderedSelection = selectionKey;
    queueMicrotask(() => props.onLayoutChange?.());
    if (restoreSelection && document.activeElement === element) setDomSelection(selection);
  };

  const renderLine = (line: SourceLine) => {
    const row = document.createElement("div");
    row.className = "markdown-editor-line";
    row.dataset.sourceFrom = String(line.from);
    row.dataset.sourceTo = String(line.to);
    row.dataset.lineIndex = String(line.index);

    const active = activeLineIndexes.has(line.index);
    if (active || line.fenced) {
      if (line.fenced) appendText(row, line.text, line.from, line.to);
      else appendSourceSegment(row, line.text, line.from);
      return row;
    }

    const heading = line.text.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      row.classList.add("is-heading", `h${heading[1].length}`);
      appendSourceSegment(row, heading[2], line.from + heading[1].length + 1);
      return row;
    }

    const task = taskLine(line.text);
    if (task) {
      row.classList.add("is-task");
      if (task.checked) row.classList.add("is-done");
      const box = document.createElement("span");
      box.className = "markdown-editor-task-box";
      box.contentEditable = "false";
      box.setAttribute("aria-hidden", "true");
      row.append(box);
      if (task.text) appendSourceSegment(row, task.text, line.from + task.prefixLength);
      else appendText(row, "", line.to, line.to);
      return row;
    }

    const bullet = line.text.match(/^([-*+])\s+(.+)$/);
    if (bullet) {
      row.classList.add("is-list");
      const marker = document.createElement("span");
      marker.className = "markdown-editor-list-marker";
      marker.textContent = "•";
      marker.contentEditable = "false";
      marker.setAttribute("aria-hidden", "true");
      row.append(marker);
      appendSourceSegment(row, bullet[2], line.from + bullet[1].length + 1);
      return row;
    }

    const numbered = line.text.match(/^(\d+[.)])\s+(.+)$/);
    if (numbered) {
      row.classList.add("is-list");
      const marker = document.createElement("span");
      marker.className = "markdown-editor-list-marker";
      marker.textContent = numbered[1];
      marker.contentEditable = "false";
      marker.setAttribute("aria-hidden", "true");
      row.append(marker);
      appendSourceSegment(row, numbered[2], line.from + numbered[1].length + 1);
      return row;
    }

    const quote = line.text.match(/^>\s?(.*)$/);
    if (quote) {
      row.classList.add("is-quote");
      appendSourceSegment(row, quote[1] || " ", line.from + line.text.length - quote[1].length);
      return row;
    }

    appendSourceSegment(row, line.text, line.from);
    return row;
  };

  const appendSourceSegment = (parent: HTMLElement, text: string, from: number) => {
    const tokens = markdownTokens(text, from);
    let cursor = from;
    for (const token of tokens) {
      if (cursor < token.from) appendText(parent, source.slice(cursor, token.from), cursor, token.from);
      appendToken(parent, token);
      cursor = token.to;
    }
    if (cursor < from + text.length || text.length === 0) {
      appendText(parent, source.slice(cursor, from + text.length), cursor, from + text.length);
    }
  };

  const appendToken = (parent: HTMLElement, token: MarkdownToken) => {
    if (activeTokenStarts.has(token.from)) {
      appendText(parent, source.slice(token.from, token.to), token.from, token.to, "markdown-editor-token is-source");
      return;
    }

    const wrapper = document.createElement("span");
    wrapper.className = `markdown-editor-token is-${token.type}`;
    wrapper.dataset.tokenFrom = String(token.from);
    wrapper.dataset.tokenTo = String(token.to);
    const content = document.createElement(token.type === "bold" ? "strong" : token.type === "italic" ? "em" : token.type === "strike" ? "s" : token.type === "code" ? "code" : "a");
    if (token.type === "link") {
      content.setAttribute("href", safeHref(token.href));
      content.setAttribute("target", "_blank");
      content.setAttribute("rel", "noreferrer");
    }
    appendText(content, token.text, token.contentFrom, token.contentTo);
    wrapper.append(content);
    parent.append(wrapper);
  };

  const appendText = (parent: HTMLElement, text: string, from: number, to: number, className = "") => {
    const span = document.createElement("span");
    span.className = className;
    span.dataset.sourceFrom = String(from);
    span.dataset.sourceTo = String(to);
    span.append(document.createTextNode(text));
    parent.append(span);
  };

  const selectionFromDom = (): SourceSelection | null => {
    const domSelection = window.getSelection();
    if (!domSelection?.rangeCount) return null;
    const range = domSelection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
    const start = sourceOffsetForDomPosition(range.startContainer, range.startOffset);
    const end = sourceOffsetForDomPosition(range.endContainer, range.endOffset);
    if (start === null || end === null) return null;
    return { start: Math.min(start, end), end: Math.max(start, end) };
  };

  const sourceOffsetForDomPosition = (node: Node, offset: number): number | null => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : null;
    if (element?.classList.contains("markdown-editor-line")) {
      const next = element.childNodes[offset];
      const previous = element.childNodes[offset - 1];
      return sourceOffsetAtStart(next) ?? sourceOffsetAtEnd(previous) ?? Number(element.dataset.sourceTo);
    }
    const text = node.nodeType === Node.TEXT_NODE ? node as Text : null;
    const sourceNode = (text?.parentElement ?? element?.closest("[data-source-from]")) as HTMLElement | null;
    if (sourceNode?.dataset.sourceFrom) {
      const from = Number(sourceNode.dataset.sourceFrom);
      const to = Number(sourceNode.dataset.sourceTo);
      const length = text?.data.length ?? to - from;
      return from + Math.max(0, Math.min(offset, length));
    }

    const row = (node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement)?.closest(".markdown-editor-line") as HTMLElement | null;
    if (!row) return null;
    const from = Number(row.dataset.sourceFrom);
    const to = Number(row.dataset.sourceTo);
    return offset <= 0 ? from : to;
  };

  const sourceOffsetAtStart = (node: Node | undefined): number | null => {
    if (!node) return null;
    if (node instanceof HTMLElement) {
      if (node.dataset.tokenFrom) return Number(node.dataset.tokenFrom);
      if (node.dataset.sourceFrom) return Number(node.dataset.sourceFrom);
      for (const child of node.childNodes) {
        const offset = sourceOffsetAtStart(child);
        if (offset !== null) return offset;
      }
    }
    return null;
  };

  const sourceOffsetAtEnd = (node: Node | undefined): number | null => {
    if (!node) return null;
    if (node instanceof HTMLElement) {
      if (node.dataset.tokenTo) return Number(node.dataset.tokenTo);
      if (node.dataset.sourceTo) return Number(node.dataset.sourceTo);
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        const offset = sourceOffsetAtEnd(node.childNodes[index]);
        if (offset !== null) return offset;
      }
    }
    return null;
  };

  const refreshPresentationForSelection = (forceInactive = false) => {
    activeTokenStarts = new Set();
    activeLineIndexes = new Set();
    if (forceInactive || (!isFocused && document.activeElement !== element)) return;
    if (revealedTokenFrom !== null && markdownTokens(source).some((token) => token.from === revealedTokenFrom)) {
      activeTokenStarts.add(revealedTokenFrom);
    }
    const isCollapsed = selection.start === selection.end;
    for (const line of lines()) {
      const prefix = line.text.match(/^(#{1,6}\s+|>\s?|[-*+]\s+|- \[[ xX]\]\s+|\d+[.)]\s+)/)?.[0];
      if (!prefix) continue;
      const prefixEnd = line.from + prefix.length;
      const selected = isCollapsed
        ? selection.start >= line.from && selection.start <= prefixEnd
        : selection.start < prefixEnd && selection.end > line.from;
      if (selected) activeLineIndexes.add(line.index);
    }
  }; 

  const setDomSelection = (next: SourceSelection) => {
    const start = domPositionForSourceOffset(next.start);
    const end = domPositionForSourceOffset(next.end);
    if (!start || !end) return;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const domSelection = window.getSelection();
    domSelection?.removeAllRanges();
    domSelection?.addRange(range);
  };

  const domPositionForSourceOffset = (offset: number) => {
    const tokenEnd = [...element.querySelectorAll<HTMLElement>("[data-token-to]")]
      .find((item) => Number(item.dataset.tokenTo) === offset);
    if (tokenEnd?.parentNode) {
      return { node: tokenEnd.parentNode, offset: [...tokenEnd.parentNode.childNodes].indexOf(tokenEnd) + 1 };
    }
    const tokenStart = [...element.querySelectorAll<HTMLElement>("[data-token-from]")]
      .find((item) => Number(item.dataset.tokenFrom) === offset);
    if (tokenStart?.parentNode) {
      return { node: tokenStart.parentNode, offset: [...tokenStart.parentNode.childNodes].indexOf(tokenStart) };
    }
    const spans = [...element.querySelectorAll<HTMLElement>("span[data-source-from]")];
    const span = spans.find((item) => {
      const from = Number(item.dataset.sourceFrom);
      const to = Number(item.dataset.sourceTo);
      return offset >= from && offset <= to;
    }) ?? spans.at(-1);
    if (!span) return null;
    const from = Number(span.dataset.sourceFrom);
    const text = span.firstChild as Text | null;
    return { node: text ?? span, offset: Math.max(0, Math.min(offset - from, text?.data.length ?? 0)) };
  };

  const sourceOffsetAtPoint = (x: number, y: number) => {
    const documentWithCaret = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = documentWithCaret.caretPositionFromPoint?.(x, y);
    if (position) return sourceOffsetForDomPosition(position.offsetNode, position.offset);
    const range = documentWithCaret.caretRangeFromPoint?.(x, y);
    return range ? sourceOffsetForDomPosition(range.startContainer, range.startOffset) : null;
  };

  const rememberSelection = () => {
    const next = selectionFromDom();
    if (!next) return;
    selection = next;
    const revealedToken = markdownTokens(source).find((token) => token.from === revealedTokenFrom);
    if (!revealedToken || next.start !== next.end || next.start < revealedToken.from || next.start > revealedToken.to) {
      revealedTokenFrom = null;
    }

  };

  const edit = (nextValue: string, nextSelection: SourceSelection, addHistory = true) => {
    if (nextValue === source && nextSelection.start === selection.start && nextSelection.end === selection.end) return;
    if (addHistory) {
      undoStack.push({ value: source, selection });
      redoStack = [];
    }
    source = nextValue;
    selection = nextSelection;
    revealedTokenFrom = null;
    activeTokenStarts = new Set();
    activeLineIndexes = new Set();
    renderedSource = "";
    render();
    notify();
  };

  const deleteBackward = (range: SourceSelection) => {
    if (range.start !== range.end) return applyMarkdownEdit(source, range, "");
    return applyMarkdownEdit(source, { start: previousGraphemeBoundary(source, range.start), end: range.end }, "");
  };

  const deleteForward = (range: SourceSelection) => {
    if (range.start !== range.end) return applyMarkdownEdit(source, range, "");
    return applyMarkdownEdit(source, { start: range.start, end: nextGraphemeBoundary(source, range.end) }, "");
  };

  const handleBeforeInput: JSX.EventHandlerUnion<HTMLDivElement, InputEvent> = (event) => {
    if (composing || event.inputType === "insertCompositionText") return;
    rememberSelection();
    const range = selection;
    let result: { value: string; selection: SourceSelection } | null = null;

    if (event.inputType === "historyUndo") {
      event.preventDefault();
      undo();
      return;
    }
    if (event.inputType === "historyRedo") {
      event.preventDefault();
      redo();
      return;
    }
    if (event.inputType === "insertText" || event.inputType === "insertReplacementText") result = applyMarkdownEdit(source, range, event.data ?? "");
    if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") result = applyMarkdownEdit(source, range, "\n");
    if (event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop") result = applyMarkdownEdit(source, range, event.dataTransfer?.getData("text/plain") ?? event.data ?? "");
    if (event.inputType === "deleteContentBackward" || event.inputType === "deleteWordBackward" || event.inputType === "deleteSoftLineBackward") result = deleteBackward(range);
    if (event.inputType === "deleteContentForward" || event.inputType === "deleteWordForward" || event.inputType === "deleteSoftLineForward") result = deleteForward(range);
    if (event.inputType === "deleteByCut") result = applyMarkdownEdit(source, range, "");
    if (event.inputType === "formatStrikeThrough") result = toggleStrikethrough(source, range);

    if (!result) return;
    if (!event.cancelable) {
      activeTokenStarts = new Set(markdownTokens(source).map((token) => token.from));
      activeLineIndexes = new Set(lines().map((line) => line.index));
      renderedSource = "";
      render(false);
      return;
    }
    event.preventDefault();
    edit(result.value, result.selection);
  };

  const beginComposition = () => {
    rememberSelection();
    if (!compositionHistoryRecorded) {
      undoStack.push({ value: source, selection });
      redoStack = [];
      compositionHistoryRecorded = true;
    }
    composing = true;
  };

  const syncComposition = () => {
    if (!composing) return;
    source = element.innerText.replace(/\r\n/g, "\n");
    selection = selectionFromDom() ?? { start: source.length, end: source.length };
    renderedSource = "";
    notify();
  };

  const finishComposition = () => {
    if (!composing) return;
    syncComposition();
    composing = false;
    compositionHistoryRecorded = false;
    renderedSource = "";
    render();
  }; 

  const undo = () => {
    const previous = undoStack.pop();
    if (!previous) return;
    redoStack.push({ value: source, selection });
    source = previous.value;
    selection = previous.selection;
    activeTokenStarts = new Set();
    activeLineIndexes = new Set();
    renderedSource = "";
    render();
    notify();
  };

  const redo = () => {
    const next = redoStack.pop();
    if (!next) return;
    undoStack.push({ value: source, selection });
    source = next.value;
    selection = next.selection;
    activeTokenStarts = new Set();
    activeLineIndexes = new Set();
    renderedSource = "";
    render();
    notify();
  };

  const reconcileArrowNavigation = (direction: "left" | "right") => {
    const entering = moveCaretIntoInlineToken(source, selection, direction);
    if (entering) {
      const token = markdownTokens(source).find((item) => direction === "right" ? item.from === entering.start : item.to === entering.start);
      if (token && revealedTokenFrom !== token.from) {
        selection = entering;
        revealedTokenFrom = token.from;
        renderedSource = "";
        return;
      }
    }

    const revealedToken = markdownTokens(source).find((token) => token.from === revealedTokenFrom);
    if (!revealedToken) return;
    if ((direction === "right" && selection.start === revealedToken.to) || (direction === "left" && selection.start === revealedToken.from)) {
      revealedTokenFrom = null;
      renderedSource = "";
    }
  };

  const handleKeyDown: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent> = (event) => {
    if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      rememberSelection();
      const direction = event.key === "ArrowLeft" ? "left" : "right";
      const entering = moveCaretIntoInlineToken(source, selection, direction);
      if (entering) {
        const token = markdownTokens(source).find((item) => direction === "right" ? item.from === entering.start : item.to === entering.start);
        if (token && revealedTokenFrom !== token.from) {
          event.preventDefault();
          selection = entering;
          revealedTokenFrom = token.from;
          pendingArrowDirection = null;
          renderedSource = "";
          render();
          return;
        }
      }
      pendingArrowDirection = direction;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    }
  };

  const handleClick: JSX.EventHandlerUnion<HTMLDivElement, MouseEvent> = (event) => {
    if (event.ctrlKey && event.button === 0) {
      event.preventDefault();
      selection = pendingStrikeSelection ?? selectionFromDom() ?? selection;
      pendingStrikeSelection = null;
      const result = toggleStrikethrough(source, selection);
      edit(result.value, result.selection);
      return;
    }
    queueMicrotask(() => {
      rememberSelection();
      render();
    });
  };

  const handleSelectionChange = () => {
    if (!isFocused || document.activeElement !== element) return;
    rememberSelection();
  };

  const handle = (): MarkdownEditorHandle => ({
    element,
    focus: () => {
      element.focus();
      setDomSelection(selection);
    },
    selection: () => ({ ...selection }),
    setSelection: (next) => {
      const start = Math.max(0, Math.min(next.start, source.length));
      const end = Math.max(start, Math.min(next.end, source.length));
      selection = { start, end };
      revealedTokenFrom = null;
      renderedSource = "";
      render();
    },
    selectAll: () => {
      selection = { start: 0, end: source.length };
      activeTokenStarts = new Set(markdownTokens(source).map((token) => token.from));
      activeLineIndexes = new Set(lines().map((line) => line.index));
      renderedSource = "";
      render();
    },
    replaceSelection: (text) => {
      const result = applyMarkdownEdit(source, selection, text);
      edit(result.value, result.selection);
    },
    cutSelection: () => {
      const value = source.slice(selection.start, selection.end);
      if (value) {
        const result = applyMarkdownEdit(source, selection, "");
        edit(result.value, result.selection);
      }
      return value;
    },
    copySelection: () => source.slice(selection.start, selection.end),
    setDirection: (direction) => { element.dir = direction; },
    collapseToEnd: () => {
      selection = { start: source.length, end: source.length };
      render();
    },
    wrapSelectionWithStrikethrough: () => {
      const result = toggleStrikethrough(source, selection);
      edit(result.value, result.selection);
    },
    setValue: (value) => {
      if (value === source) return;
      source = value;
      selection = { start: Math.min(selection.start, value.length), end: Math.min(selection.end, value.length) };
      activeTokenStarts = new Set();
      activeLineIndexes = new Set();
      renderedSource = "";
      render(document.activeElement === element);
    },
  });

  onMount(() => {
    source = props.value;
    isFocused = document.activeElement === element;
    selection = { start: source.length, end: source.length };
    renderedSource = "";
    render(false);
    props.ref?.(handle());
    document.addEventListener("selectionchange", handleSelectionChange);
  });

  onCleanup(() => document.removeEventListener("selectionchange", handleSelectionChange));

  createEffect(() => {
    const externalValue = props.value;
    if (externalValue === source || externalValue === lastEmittedValue) return;
    source = externalValue;
    selection = { start: Math.min(selection.start, source.length), end: Math.min(selection.end, source.length) };
    renderedSource = "";
    render(document.activeElement === element);
  });

  return (
    <div
      ref={element}
      class="note-body-editor markdown-editor"
      role="textbox"
      aria-label={props.label}
      aria-multiline="true"
      data-placeholder={props.placeholder}
      contenteditable="true"
      spellcheck={false}
      onBeforeInput={handleBeforeInput}
      onCompositionStart={beginComposition}
      onCompositionEnd={finishComposition}
      onInput={syncComposition}
      onContextMenu={(event) => props.onContextMenu?.(event)}
      onPointerDown={(event) => {
        revealedTokenFrom = null;
        if (event.ctrlKey && event.button === 0) {
          const existing = selectionFromDom();
          pendingStrikeSelection = existing && existing.start !== existing.end
            ? existing
            : (() => {
              const offset = sourceOffsetAtPoint(event.clientX, event.clientY);
              return offset === null ? existing ?? selection : { start: offset, end: offset };
            })();
        }
        props.onPointerDown?.(event);
      }}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onKeyUp={() => {
        rememberSelection();
        if (pendingArrowDirection) reconcileArrowNavigation(pendingArrowDirection);
        pendingArrowDirection = null;
        render();
      }}
      onPointerUp={() => {
        if (pendingStrikeSelection) return;
        rememberSelection();
        render();
      }}
      onPointerCancel={() => {
        pendingStrikeSelection = null;
      }}
      onFocus={() => {
        isFocused = true;
        rememberSelection();
        props.onFocus?.();
        renderedSource = "";
        render();
      }}
      onBlur={() => {
        isFocused = false;
        revealedTokenFrom = null;
        renderedSource = "";
        render(false, true);
        props.onBlur?.();
      }}
    />
  );
}

function safeHref(href: string) {
  return /^(https?:|mailto:|#)/i.test(href) ? href : "#";
}
