import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');

console.log('NexusRoute root directory:', rootDir);

export function updateFile(relPath, content) {
  const targetPath = path.join(rootDir, relPath);
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(targetPath, content, 'utf8');
  console.log(`Updated: ${relPath} (${content.length} bytes)`);
}

export function readFile(relPath) {
  const targetPath = path.join(rootDir, relPath);
  return fs.readFileSync(targetPath, 'utf8');
}
