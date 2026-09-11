import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import ts from "typescript";
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
it("accepts every literal frontend diagnostic event at the native boundary", () => {
  const native = readFileSync("src-tauri/src/diagnostics.rs", "utf8").split("fn allowed_event(")[1].split("#[tauri::command]")[0];
  const allowed = new Set(Array.from(native.matchAll(/"([a-z-]+)"/g), match => match[1]));
  const events = new Set<string>();
  for (const file of files("src").filter(file => /\.tsx?$/.test(file) && !/\.(test|spec)\./.test(file))) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "recordDiagnostic" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) events.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(events.size).toBeGreaterThan(10);
  expect([...events].filter(event => !allowed.has(event))).toEqual([]);
});
