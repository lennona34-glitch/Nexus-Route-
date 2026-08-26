const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

// 1. Fix src/adapters/index.ts
const adaptersPath = path.join(rootDir, 'src/adapters/index.ts');
let adapters = fs.readFileSync(adaptersPath, 'utf8');
adapters = adapters.replace(/export \* from '\.\/interface';/g, "export * from './base';");
fs.writeFileSync(adaptersPath, adapters, 'utf8');
console.log('Fixed adapters/index.ts');

// 2. Fix src/server.ts
const serverPath = path.join(rootDir, 'src/server.ts');
let server = fs.readFileSync(serverPath, 'utf8');
server = server.replace(/const keyList = key\.split\([\s\S]*?\)\.map/, 'const keyList = key.split(/[,\\r\\n]+/).map');
fs.writeFileSync(serverPath, server, 'utf8');
console.log('Fixed server.ts');
