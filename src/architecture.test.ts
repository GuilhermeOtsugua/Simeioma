import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import ts from "typescript";
const imports = (file: string) => ts.createSourceFile(file, readFileSync(`src/${file}`, "utf8"), ts.ScriptTarget.Latest, true)
  .statements.filter(ts.isImportDeclaration).map(statement => (statement.moduleSpecifier as ts.StringLiteral).text);
it("keeps native commands out of the application router", () => {
  expect(imports("App.tsx").filter(path => path.startsWith("@tauri-apps/"))).toEqual([]);
});
it("keeps state and native services independent of window views", () => {
  for (const file of ["persistence.ts", "noteMutations.ts", "noteWindows.ts", "launcherNative.ts", "utilityWindows.ts", "exports.ts", "reminders.ts"]) {
    expect(imports(file).filter(path => /(^|\/)App$|\/windows\//.test(path))).toEqual([]);
  }
});
