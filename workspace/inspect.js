const fs = require('fs');
const path = require('path');

const root = path.resolve('..');
console.log('Project root:', root);

const html = fs.readFileSync(path.join(root, 'src/web/public/index.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'src/web/public/app.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'src/server.ts'), 'utf8');

console.log('HTML size:', html.length, 'lines:', html.split('\n').length);
console.log('JS size:', js.length, 'lines:', js.split('\n').length);
console.log('Server size:', server.length, 'lines:', server.split('\n').length);
