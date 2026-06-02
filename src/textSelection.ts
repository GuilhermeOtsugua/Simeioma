export function editablePlainText(editor: HTMLElement) {
  return (editor.innerText || editor.textContent || "").replace(/\r\n/g, "\n");
}

export function syncEditableText(editor: HTMLElement | undefined, text: string) {
  if (!editor) return;
  if (editablePlainText(editor) !== text) editor.textContent = text;
}

export function currentEditorRange(editor: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.anchorNode || !selection.focusNode) return null;
  if (!nodeInside(editor, selection.anchorNode) || !nodeInside(editor, selection.focusNode)) return null;
  return selection.getRangeAt(0).cloneRange();
}

export function collapsedEditorEndRange(editor: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  return range;
}

export function selectEditorRange(range: Range) {
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

export function hasActiveTextSelection(editor: HTMLElement | undefined) {
  if (editor) {
    const range = currentEditorRange(editor);
    if (range && !range.collapsed) return true;
  }
  return Boolean(document.getSelection()?.toString());
}

export function editableSelectionOffsets(editor: HTMLElement) {
  const range = currentEditorRange(editor);
  if (!range) return null;
  const start = document.createRange();
  start.selectNodeContents(editor);
  start.setEnd(range.startContainer, range.startOffset);
  const end = document.createRange();
  end.selectNodeContents(editor);
  end.setEnd(range.endContainer, range.endOffset);
  return { start: start.toString().length, end: end.toString().length };
}

export function setEditorSelectionOffsets(editor: HTMLElement, start: number, end: number) {
  const range = document.createRange();
  const from = editorTextPosition(editor, start);
  const to = editorTextPosition(editor, end);
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  selectEditorRange(range);
}

function nodeInside(root: HTMLElement, node: Node) {
  return node === root || root.contains(node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement);
}

function editorTextPosition(editor: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, offset);
  let last: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    last = node;
    if (remaining <= node.data.length) return { node, offset: remaining };
    remaining -= node.data.length;
  }
  if (last) return { node: last, offset: last.data.length };
  const text = document.createTextNode("");
  editor.appendChild(text);
  return { node: text, offset: 0 };
}
