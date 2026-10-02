const fs = require('fs');
const html = fs.readFileSync('src/web/public/index.html', 'utf8');
const allLines = html.split('\n');
let meshLine = -1;
for (let i = 0; i < allLines.length; i++) {
  if (allLines[i].includes('id="meshModal"')) {
    meshLine = i;
    break;
  }
}
const stack = [];
for (let i = meshLine; i < 3905; i++) {
  const line = allLines[i];
  const re = /<\/?div\b[^>]*>/gi;
  let match;
  while ((match = re.exec(line)) !== null) {
    const tag = match[0];
    if (tag.startsWith('</')) {
      if (stack.length > 0) {
        stack.pop();
      } else {
        console.log('Extra close div at line', i + 1);
      }
    } else {
      stack.push({ line: i + 1, tag: tag.substring(0, 50) });
    }
  }
}
console.log('Unclosed divs count:', stack.length);
stack.forEach(s => console.log(`Unclosed div opened at line ${s.line}: ${s.tag}`));
