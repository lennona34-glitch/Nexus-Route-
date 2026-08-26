import fs from 'fs';
import path from 'path';

const root = path.resolve('..');
console.log('Project root:', root);

// Check if vault directory exists
const vaultDir = path.join(root, 'src', 'vault');
console.log('Vault dir exists:', fs.existsSync(vaultDir));

// Read server.ts header & structure
const server = fs.readFileSync(path.join(root, 'src', 'server.ts'), 'utf8');
console.log('Server lines:', server.split('\n').length);
