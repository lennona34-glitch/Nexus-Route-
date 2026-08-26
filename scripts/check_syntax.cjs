const fs = require('fs');
const ts = require('typescript');
const code = fs.readFileSync('src/web/public/app.js', 'utf8');
const sourceFile = ts.createSourceFile('app.js', code, ts.ScriptTarget.Latest, true);
const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram(['src/web/public/app.js'], { allowJs: true, noEmit: true }));
console.log('Syntactic diagnostics count:', sourceFile.parseDiagnostics.length);
sourceFile.parseDiagnostics.forEach(d => {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(d.start);
  console.log(`Line ${line + 1}, Col ${character + 1}: ${d.messageText}`);
});
