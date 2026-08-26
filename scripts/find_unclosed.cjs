const fs = require('fs');
const ts = require('typescript');
const code = fs.readFileSync('src/web/public/app.js', 'utf8');
const sourceFile = ts.createSourceFile('app.js', code, ts.ScriptTarget.Latest, true);

function inspect(node, depth = 0) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isIfStatement(node) || ts.isBlock(node)) {
    // print start line and kind
    console.log(`${" ".repeat(depth)}${ts.SyntaxKind[node.kind]} at line ${line + 1}`);
  }
  ts.forEachChild(node, c => inspect(c, depth + 1));
}
inspect(sourceFile);
