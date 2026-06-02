export function keyCombo(event: KeyboardEvent) {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Meta");
  const key = readableKey(event.key);
  if (key && !["Ctrl", "Shift", "Alt", "Meta"].includes(key)) parts.push(key);
  return parts.join(" + ");
}

export function pointerCombo(event: MouseEvent | PointerEvent) {
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push("Meta");
  parts.push(mouseButtonName(event.button));
  return parts.join(" + ");
}

export function matchesCombo(actual: string, expected: string) {
  return normalizeCombo(actual) === normalizeCombo(expected);
}

function readableKey(key: string) {
  if (key === " ") return "Space";
  if (key === "Control") return "Ctrl";
  if (key === "Escape") return "Esc";
  if (key.length === 1) return key.toUpperCase();
  return key.replace(/^Key/, "").replace(/^Digit/, "");
}

function normalizeCombo(combo: string) {
  return combo
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join("+");
}

function mouseButtonName(button: number) {
  if (button === 0) return "left click";
  if (button === 1) return "middle click";
  if (button === 2) return "right click";
  return `button ${button}`;
}
