const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
console.log('NexusRoute root directory:', rootDir);

// Let's test reading package.json
const pkgPath = path.join(rootDir, 'package.json');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  console.log('Found package:', pkg.name, 'version:', pkg.version);
}
