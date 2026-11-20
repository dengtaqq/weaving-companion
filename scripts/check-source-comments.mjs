import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** 枚举 src 中需要方法说明的 TypeScript 源文件。 */
function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : /\.tsx?$/.test(entry.name) ? [target] : [];
  });
}

/** 获取具名函数、类方法、接口方法或具名箭头函数的名称。 */
function functionName(node, source) {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isMethodSignature(node)
  )
    return node.name?.getText(source) ?? "constructor";
  if (
    (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  )
    return node.name.getText(source);
  return null;
}

/** 检查注释是否直接位于声明上方，报告遗漏而不修改源码。 */
function inspectFile(file) {
  const content = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let total = 0;
  const missing = [];
  const visit = (node) => {
    const name = functionName(node, source);
    if (name) {
      total++;
      const declaration =
        ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node;
      const start = declaration.getStart(source);
      const lineStart = content.lastIndexOf("\n", start - 1) + 1;
      const previousLine = content.slice(0, lineStart).split(/\r?\n/).at(-2)?.trim() ?? "";
      if (!declaration.jsDoc?.length && !previousLine.endsWith("*/") && !previousLine.startsWith("//")) {
        const line = source.getLineAndCharacterOfPosition(start).line + 1;
        missing.push(`${file}:${line} ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { total, missing };
}

const results = sourceFiles("src").map(inspectFile);
const total = results.reduce((count, result) => count + result.total, 0);
const missing = results.flatMap((result) => result.missing);
process.stdout.write(`方法职责注释：${total - missing.length}/${total}\n`);
if (missing.length) {
  process.stderr.write(`${missing.join("\n")}\n`);
  process.exitCode = 1;
}
