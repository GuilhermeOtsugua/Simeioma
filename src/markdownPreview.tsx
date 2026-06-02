import { For } from "solid-js";

type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; depth: number; text: string }
  | { type: "task"; checked: boolean; text: string }
  | { type: "bullet"; text: string }
  | { type: "numbered"; marker: string; text: string }
  | { type: "quote"; text: string }
  | { type: "code"; text: string }
  | { type: "hr" };

export function renderMarkdownPreview(value: string) {
  const blocks = parseMarkdownBlocks(value);
  if (!blocks.length) return <p class="placeholder-line">Write...</p>;
  return <For each={blocks}>{renderMarkdownBlock}</For>;
}

function parseMarkdownBlocks(value: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = value.split("\n");
  let codeLines: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      if (codeLines) {
        blocks.push({ type: "code", text: codeLines.join("\n") });
        codeLines = null;
      } else {
        codeLines = [];
      }
      continue;
    }
    if (codeLines) {
      codeLines.push(line);
      continue;
    }
    if (!trimmed) {
      blocks.push({ type: "paragraph", text: "" });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: "heading", depth: heading[1].length, text: heading[2] });
      continue;
    }

    const task = line.match(/^- \[( |x)\]\s+(.*)$/i);
    if (task) {
      blocks.push({ type: "task", checked: task[1].toLowerCase() === "x", text: task[2] });
      continue;
    }

    const bullet = line.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      blocks.push({ type: "bullet", text: bullet[1] });
      continue;
    }

    const numbered = line.match(/^(\d+[.)])\s+(.+)$/);
    if (numbered) {
      blocks.push({ type: "numbered", marker: numbered[1], text: numbered[2] });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push({ type: "quote", text: quote[1] });
      continue;
    }

    if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
      blocks.push({ type: "hr" });
      continue;
    }

    blocks.push({ type: "paragraph", text: line });
  }

  if (codeLines) blocks.push({ type: "code", text: codeLines.join("\n") });
  return blocks.filter((block, index, all) => block.type !== "paragraph" || block.text || index < all.length - 1);
}

function renderMarkdownBlock(block: MarkdownBlock) {
  if (block.type === "heading") {
    return <p class={`preview-heading h${Math.min(6, block.depth)}`}>{renderInlineMarkdown(block.text)}</p>;
  }
  if (block.type === "task") {
    return (
      <p class="preview-task" classList={{ "is-done": block.checked }}>
        <span class="preview-checkbox" />
        {renderInlineMarkdown(block.text || " ")}
      </p>
    );
  }
  if (block.type === "bullet") {
    return <p class="preview-list"><span>•</span>{renderInlineMarkdown(block.text)}</p>;
  }
  if (block.type === "numbered") {
    return <p class="preview-list"><span>{block.marker}</span>{renderInlineMarkdown(block.text)}</p>;
  }
  if (block.type === "quote") {
    return <p class="preview-quote">{renderInlineMarkdown(block.text || " ")}</p>;
  }
  if (block.type === "code") {
    return <pre class="preview-code-block"><code>{block.text || " "}</code></pre>;
  }
  if (block.type === "hr") {
    return <hr class="preview-hr" />;
  }
  return <p>{renderInlineMarkdown(block.text || " ")}</p>;
}

function renderInlineMarkdown(value: string) {
  const parts = value.split(/(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`)/g).filter(Boolean);
  return (
    <For each={parts}>
      {(part) => {
        const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link) return <a class="preview-link" href={safeMarkdownHref(link[2])}>{link[1]}</a>;
        if (part.startsWith("**") && part.endsWith("**")) return <strong>{part.slice(2, -2)}</strong>;
        if (part.startsWith("*") && part.endsWith("*")) return <em>{part.slice(1, -1)}</em>;
        if (part.startsWith("~~") && part.endsWith("~~")) return <s>{part.slice(2, -2)}</s>;
        if (part.startsWith("`") && part.endsWith("`")) return <code>{part.slice(1, -1)}</code>;
        return <span>{part}</span>;
      }}
    </For>
  );
}

function safeMarkdownHref(href: string) {
  return /^(https?:|mailto:|#)/i.test(href) ? href : "#";
}
