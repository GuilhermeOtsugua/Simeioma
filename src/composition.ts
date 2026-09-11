import { applyMarkdownEdit, type SourceSelection } from "./markdownEditorModel";

// Composition edits a literal-source DOM. Reject unexpected edits outside its source range.
export function commitComposition(source: string, range: SourceSelection, domText: string) {
  const prefix = source.slice(0, range.start), suffix = source.slice(range.end);
  if (!domText.startsWith(prefix) || !domText.endsWith(suffix) || domText.length < prefix.length + suffix.length) return null;
  return applyMarkdownEdit(source, range, domText.slice(prefix.length, domText.length - suffix.length));
}
