import fs from 'fs';
import path from 'path';
import os from 'os';
import { isInsideDir, SecurityError } from '../security/path.js';
import type { FileNode, FileSearchResult } from './types.js';

const BLOCKED_NAMES = new Set([
  '.git',
  'node_modules',
  '.venv',
  '__pycache__',
  '.env',
  '.env.local',
  '.env.production',
  '.env.example',
  'id_rsa',
  'id_rsa.pub',
  'id_ed25519',
  'id_ed25519.pub',
  'credentials.json',
  'client_secret.json',
  '.npmrc',
  'dist',
  'build',
  'bin',
  'obj',
  'target',
  '.cache',
  '.vs',
  '.idea',
  'vendor',
  '$recycle.bin',
  '__pycache__',
  'venv',
  '.venv',
  'env',
  '.gradle',
  'gradle',
  'out',
  'coverage',
  '.dart_tool',
  'cmake-build-debug',
  'cmake-build-release',
  '.cxx',
  'Pods',
  'DerivedData',
  'site-packages',
]);

const BLOCKED_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.p12',
  '.pfx',
]);

export class ShareManager {
  private sharedDirs: string[] = [];
  private cachedTree: FileNode[] = [];
  private totalFilesCount: number = 0;
  private totalBytes: number = 0;
  private lastIndexedAt: number = 0;
  private configPath: string = path.resolve(process.cwd(), 'data', 'mesh_shares.json');

  constructor(initialDirs?: string[]) {
    const dirSet = new Set<string>();

    // 1. Add explicitly passed initial dirs or default shared/workspace
    if (initialDirs && initialDirs.length > 0) {
      for (const d of initialDirs) {
        dirSet.add(path.resolve(d));
      }
    } else {
      const defaultShared = path.resolve(process.cwd(), 'shared');
      if (!fs.existsSync(defaultShared)) {
        try { fs.mkdirSync(defaultShared, { recursive: true }); } catch { }
      }
      dirSet.add(defaultShared);
      dirSet.add(path.resolve(process.cwd(), 'workspace'));

      // 2. Load persisted shares from data/mesh_shares.json
      try {
        if (fs.existsSync(this.configPath)) {
          const raw = fs.readFileSync(this.configPath, 'utf-8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed.sharedDirs)) {
            for (const d of parsed.sharedDirs) {
              if (typeof d === 'string' && fs.existsSync(d)) {
                dirSet.add(path.resolve(d));
              }
            }
          }
        }
      } catch (e) {
        console.warn('[ShareManager] Could not read persisted mesh_shares.json:', e);
      }

      // 3. Auto-detect common Desktop DEV and media folders
      try {
        const desktop = path.join(os.homedir(), 'Desktop');
        const autoMountNames = ['DEV FOLDER', 'dev', 'Converted Music'];
        for (const name of autoMountNames) {
          const candidate = path.join(desktop, name);
          if (fs.existsSync(candidate)) {
            dirSet.add(path.resolve(candidate));
          }
        }
      } catch { }
    }

    this.sharedDirs = Array.from(dirSet);
    if (!initialDirs || initialDirs.length === 0) {
      this.saveConfig();
    }
  }

  private saveConfig(): void {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify({ sharedDirs: this.sharedDirs }, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[ShareManager] Could not save mesh_shares.json:', e);
    }
  }

  public suggestDesktopFolders(): Array<{ name: string; path: string; exists: boolean; mounted: boolean }> {
    const desktop = path.join(os.homedir(), 'Desktop');
    const candidates = [
      'DEV FOLDER',
      'dev',
      'Converted Music',
      'anti-gravity daw-app',
      'Locked Almost Finished Archives',
      'FAMILY PHOTOS AND VIDEOS',
      'Projects',
      'Project'
    ];
    const results: Array<{ name: string; path: string; exists: boolean; mounted: boolean }> = [];

    for (const name of candidates) {
      const p = path.join(desktop, name);
      const exists = fs.existsSync(p);
      if (exists) {
        const resolved = path.resolve(p);
        const mounted = this.sharedDirs.includes(resolved);
        results.push({ name, path: resolved, exists, mounted });
      }
    }
    return results;
  }

  public getSharedDirs(): string[] {
    return [...this.sharedDirs];
  }

  public setSharedDirs(dirs: string[]): void {
    this.sharedDirs = dirs.map(d => path.resolve(d));
    this.saveConfig();
    this.rescan();
  }

  public addSharedDir(dir: string): boolean {
    const clean = dir.trim().replace(/^["']|["']$/g, '');
    const resolved = path.resolve(clean);
    if (!fs.existsSync(resolved)) return false;
    if (!this.sharedDirs.includes(resolved)) {
      this.sharedDirs.push(resolved);
      this.saveConfig();
      this.rescan();
      return true;
    }
    return false;
  }

  public removeSharedDir(dir: string): boolean {
    const clean = dir.trim().replace(/^["']|["']$/g, '');
    const resolved = path.resolve(clean);
    const idx = this.sharedDirs.indexOf(resolved);
    if (idx !== -1) {
      this.sharedDirs.splice(idx, 1);
      this.saveConfig();
      this.rescan();
      return true;
    }
    return false;
  }

  public getStats(): { totalFiles: number; totalBytes: number; lastIndexedAt: number } {
    return {
      totalFiles: this.totalFilesCount,
      totalBytes: this.totalBytes,
      lastIndexedAt: this.lastIndexedAt,
    };
  }

  public rescan(): void {
    let fileCount = 0;
    let byteCount = 0;
    const roots: FileNode[] = [];

    for (const baseDir of this.sharedDirs) {
      if (!fs.existsSync(baseDir)) continue;

      const baseName = path.basename(baseDir);
      const rootNode: FileNode = {
        name: baseName,
        path: baseName,
        isDirectory: true,
        size: 0,
        modifiedAt: new Date().toISOString(),
        children: [],
      };

      const scanDir = (currentDir: string, relPath: string, parentNode: FileNode, depth = 0) => {
        if (depth > 4 || !fs.existsSync(currentDir)) return;
        if (parentNode.children && parentNode.children.length >= 100) return;

        try {
          const entries = fs.readdirSync(currentDir, { withFileTypes: true });
          for (const entry of entries) {
            if (parentNode.children && parentNode.children.length >= 100) break;
            const entryName = entry.name;
            if (this.isBlocked(entryName)) continue;

            const fullPath = path.join(currentDir, entryName);
            const currentRel = relPath ? `${relPath}/${entryName}` : entryName;

            try {
              if (entry.isDirectory()) {
                const dirNode: FileNode = {
                  name: entryName,
                  path: currentRel,
                  isDirectory: true,
                  size: 0,
                  modifiedAt: new Date().toISOString(),
                  children: [],
                };
                parentNode.children!.push(dirNode);
                scanDir(fullPath, currentRel, dirNode, depth + 1);
                parentNode.size += dirNode.size;
              } else if (entry.isFile()) {
                const stat = fs.statSync(fullPath);
                const ext = path.extname(entryName).toLowerCase();
                const category = this.categorize(entryName, ext);
                const fileNode: FileNode = {
                  name: entryName,
                  path: currentRel,
                  isDirectory: false,
                  size: stat.size,
                  modifiedAt: stat.mtime.toISOString(),
                  category,
                };
                parentNode.children!.push(fileNode);
                parentNode.size += stat.size;
                fileCount++;
                byteCount += stat.size;
              }
            } catch { }
          }
        } catch { }
      };

      scanDir(baseDir, baseName, rootNode, 0);
      roots.push(rootNode);
    }

    this.cachedTree = roots;
    this.totalFilesCount = fileCount;
    this.totalBytes = byteCount;
    this.lastIndexedAt = Date.now();
  }

  public getTree(): FileNode[] {
    if (this.cachedTree.length === 0 || Date.now() - this.lastIndexedAt > 600000) {
      this.rescan();
    }
    return this.cachedTree;
  }

  public search(query: string, peerId = 'local', peerHandle = 'You', limit = 250): FileSearchResult[] {
    const q = (query || '').trim().toLowerCase();
    const matchAll = !q || q === '*';

    const results: FileSearchResult[] = [];

    const searchNode = (node: FileNode, rootBaseName: string) => {
      if (results.length >= limit) return;
      if (!node.isDirectory) {
        if (matchAll || node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q) || (node.category && node.category.toLowerCase().includes(q))) {
          const relPath = `${rootBaseName}/${node.path}`;
          results.push({
            peerId,
            peerHandle,
            name: node.name,
            relPath,
            relativePath: relPath,
            size: node.size,
            modifiedAt: node.modifiedAt,
            category: node.category || 'other',
          });
        }
      } else if (node.children) {
        for (const child of node.children) {
          if (results.length >= limit) break;
          searchNode(child, rootBaseName);
        }
      }
    };

    const tree = this.getTree();
    for (const root of tree) {
      if (results.length >= limit) break;
      if (root.children) {
        for (const child of root.children) {
          if (results.length >= limit) break;
          searchNode(child, root.name);
        }
      }
    }

    return results;
  }

  public resolveSafeFile(targetRelPath: string): { absolutePath: string; size: number; mimeType: string } {
    if (!targetRelPath || typeof targetRelPath !== 'string') {
      throw new SecurityError('Invalid file path specified.');
    }

    let decoded = targetRelPath;
    try {
      decoded = decodeURIComponent(targetRelPath);
    } catch { }

    const normalized = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = normalized.split('/');
    if (parts.length === 0 || parts.some(p => p === '..' || p === '.')) {
      throw new SecurityError('Directory traversal detected in file path.');
    }

    // 1. Check if first segment matches the basename of any shared directory
    const rootName = parts[0].toLowerCase();
    let matchedBase: string | null = null;
    let subPath = parts.slice(1).join(path.sep);

    for (const base of this.sharedDirs) {
      if (path.basename(base).toLowerCase() === rootName) {
        matchedBase = base;
        break;
      }
    }

    let fullTarget: string | null = null;
    if (matchedBase) {
      const candidate = path.resolve(matchedBase, subPath);
      if (isInsideDir(candidate, matchedBase) && fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
        fullTarget = candidate;
      }
    }

    // 2. If not found or if path didn't include the root folder name, search across all shared directories
    if (!fullTarget) {
      for (const base of this.sharedDirs) {
        // Direct relative path inside base
        const candidate1 = path.resolve(base, normalized.replace(/\//g, path.sep));
        if (isInsideDir(candidate1, base) && fs.existsSync(candidate1) && !fs.statSync(candidate1).isDirectory()) {
          matchedBase = base;
          fullTarget = candidate1;
          break;
        }
        // SubPath if first part was an arbitrary folder
        if (parts.length > 1) {
          const candidate2 = path.resolve(base, subPath);
          if (isInsideDir(candidate2, base) && fs.existsSync(candidate2) && !fs.statSync(candidate2).isDirectory()) {
            matchedBase = base;
            fullTarget = candidate2;
            break;
          }
        }
      }
    }

    // 3. Fallback to default if still null
    if (!fullTarget) {
      if (matchedBase) {
        fullTarget = path.resolve(matchedBase, subPath);
      } else if (this.sharedDirs.length > 0) {
        matchedBase = this.sharedDirs[0];
        fullTarget = path.resolve(matchedBase, normalized.replace(/\//g, path.sep));
      } else {
        throw new SecurityError('No shared directories configured.');
      }
    }

    if (!matchedBase || (!isInsideDir(fullTarget, matchedBase) && fullTarget !== matchedBase)) {
      throw new SecurityError(`Access denied: File resolves outside shared folder.`);
    }

    const fileName = path.basename(fullTarget);
    if (this.isBlocked(fileName)) {
      throw new SecurityError(`Access denied: File "${fileName}" is restricted.`);
    }

    if (!fs.existsSync(fullTarget) || fs.statSync(fullTarget).isDirectory()) {
      throw new SecurityError(`File not found or is a directory: "${targetRelPath}"`);
    }

    const stat = fs.statSync(fullTarget);
    const mimeType = this.getMimeType(fileName);

    return {
      absolutePath: fullTarget,
      size: stat.size,
      mimeType,
    };
  }

  public resolveSafeDirectory(targetRelPath: string): { absolutePath: string; dirName: string } {
    if (!targetRelPath || typeof targetRelPath !== 'string') {
      throw new SecurityError('Invalid directory path specified.');
    }

    let decoded = targetRelPath;
    try {
      decoded = decodeURIComponent(targetRelPath);
    } catch { }

    const normalized = decoded.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    const parts = normalized.split('/');
    if (parts.length === 0 || parts.some(p => p === '..' || p === '.')) {
      throw new SecurityError('Directory traversal detected in directory path.');
    }

    const rootName = parts[0].toLowerCase();
    let matchedBase: string | null = null;
    let subPath = parts.slice(1).join(path.sep);

    for (const base of this.sharedDirs) {
      if (path.basename(base).toLowerCase() === rootName) {
        matchedBase = base;
        break;
      }
    }

    if (matchedBase) {
      if (parts.length === 1) {
        return { absolutePath: matchedBase, dirName: path.basename(matchedBase) };
      }
      const candidate = path.resolve(matchedBase, subPath);
      if (isInsideDir(candidate, matchedBase) && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return { absolutePath: candidate, dirName: path.basename(candidate) };
      }
    }

    // Fallback: search across all shared directories
    for (const base of this.sharedDirs) {
      const candidate = path.resolve(base, normalized.replace(/\//g, path.sep));
      if (isInsideDir(candidate, base) && fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return { absolutePath: candidate, dirName: path.basename(candidate) };
      }
      if (parts.length > 1) {
        const candidate2 = path.resolve(base, subPath);
        if (isInsideDir(candidate2, base) && fs.existsSync(candidate2) && fs.statSync(candidate2).isDirectory()) {
          return { absolutePath: candidate2, dirName: path.basename(candidate2) };
        }
      }
    }

    throw new SecurityError(`Directory not found or access denied: "${targetRelPath}"`);
  }

  public getDirectoryStats(dirPath: string): { fileCount: number; totalBytes: number } {
    let fileCount = 0;
    let totalBytes = 0;

    const walk = (current: string, depth = 0) => {
      if (depth > 8) return;
      try {
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
          if (this.isBlocked(entry.name)) continue;
          const full = path.join(current, entry.name);
          if (entry.isFile()) {
            fileCount++;
            try {
              totalBytes += fs.statSync(full).size;
            } catch { }
          } else if (entry.isDirectory()) {
            walk(full, depth + 1);
          }
        }
      } catch { }
    };

    walk(dirPath);
    return { fileCount, totalBytes };
  }

  public getDirectoryFlatFiles(targetRelPath: string): Array<{ name: string; relativePath: string; size: number }> {
    const resolved = this.resolveSafeDirectory(targetRelPath);
    const files: Array<{ name: string; relativePath: string; size: number }> = [];

    const walk = (currentDir: string, relPrefix = '', depth = 0) => {
      if (depth > 8 || files.length >= 2000) return;
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (this.isBlocked(entry.name)) continue;
          const full = path.join(currentDir, entry.name);
          const relItemPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
          if (entry.isFile()) {
            try {
              const stat = fs.statSync(full);
              files.push({
                name: entry.name,
                relativePath: relItemPath,
                size: stat.size,
              });
            } catch { }
          } else if (entry.isDirectory()) {
            walk(full, relItemPath, depth + 1);
          }
        }
      } catch { }
    };

    walk(resolved.absolutePath);
    return files;
  }

  private isBlocked(name: string): boolean {
    if (BLOCKED_NAMES.has(name.toLowerCase())) return true;
    if (name.startsWith('.') && name !== '.') return true;
    const ext = path.extname(name).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) return true;
    if (name.toLowerCase().endsWith('.log')) return true;
    return false;
  }

  private categorize(name: string, ext: string): FileNode['category'] {
    const loraHints = ['lora', 'adapter', 'flux_lora', 'sdxl_lora'];
    const isLora = loraHints.some(h => name.toLowerCase().includes(h));

    if (['.safetensors', '.gguf', '.bin', '.pt', '.onnx'].includes(ext)) {
      return isLora ? 'loras' : 'models';
    }
    if (['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.opus', '.wma', '.mid', '.midi', '.aif', '.aiff'].includes(ext)) {
      return 'audio';
    }
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg', '.tiff', '.ico'].includes(ext)) {
      return 'image';
    }
    if (['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.wmv'].includes(ext)) {
      return 'video';
    }
    if (['.tap', '.tzx', '.dsk', '.sna', '.z80', '.rom', '.adf', '.iso', '.chd'].includes(ext)) {
      return 'retro';
    }
    if (['.py', '.ts', '.js', '.cpp', '.c', '.h', '.cs', '.html', '.css', '.json', '.yaml', '.rs', '.go'].includes(ext)) {
      return 'code';
    }
    if (['.pdf', '.md', '.txt', '.doc', '.docx', '.epub'].includes(ext)) {
      return 'docs';
    }
    return 'other';
  }

  private getMimeType(fileName: string): string {
    const ext = path.extname(fileName).toLowerCase();
    const map: Record<string, string> = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
      '.aac': 'audio/aac',
      '.opus': 'audio/opus',
      '.wma': 'audio/x-ms-wma',
      '.mid': 'audio/midi',
      '.midi': 'audio/midi',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.json': 'application/json',
      '.txt': 'text/plain; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.tar': 'application/x-tar',
      '.gz': 'application/gzip',
      '.safetensors': 'application/octet-stream',
      '.gguf': 'application/octet-stream',
      '.dsk': 'application/octet-stream',
      '.tap': 'application/octet-stream',
      '.tzx': 'application/octet-stream',
      '.sna': 'application/octet-stream',
      '.z80': 'application/octet-stream',
    };
    return map[ext] || 'application/octet-stream';
  }

  public findCoverArt(targetRelPath: string): { relativePath: string; absolutePath: string; mimeType: string } | null {
    try {
      if (!targetRelPath) return null;
      const resolved = this.resolveSafeFile(targetRelPath);
      let targetDir = path.dirname(resolved.absolutePath);
      if (fs.existsSync(resolved.absolutePath) && fs.statSync(resolved.absolutePath).isDirectory()) {
        targetDir = resolved.absolutePath;
      }

      if (!fs.existsSync(targetDir)) return null;

      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp']);

      // 1. Check for track-specific artwork: e.g. trackname.jpg
      const baseNameWithoutExt = path.parse(path.basename(resolved.absolutePath)).name.toLowerCase();
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (imageExtensions.has(ext)) {
          const entryBase = path.parse(entry.name).name.toLowerCase();
          if (entryBase === baseNameWithoutExt) {
            const abs = path.join(targetDir, entry.name);
            const rel = this.getRelPathFromAbsolute(abs);
            return { relativePath: rel, absolutePath: abs, mimeType: this.getMimeType(entry.name) };
          }
        }
      }

      // 2. Check for standard cover filenames
      const priorityNames = ['cover', 'folder', 'albumart', 'album_art', 'art', 'front'];
      for (const pName of priorityNames) {
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (imageExtensions.has(ext)) {
            const entryBase = path.parse(entry.name).name.toLowerCase();
            if (entryBase === pName) {
              const abs = path.join(targetDir, entry.name);
              const rel = this.getRelPathFromAbsolute(abs);
              return { relativePath: rel, absolutePath: abs, mimeType: this.getMimeType(entry.name) };
            }
          }
        }
      }

      // 3. Fallback to any valid image in the directory
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (imageExtensions.has(ext) && !this.isBlocked(entry.name)) {
          const abs = path.join(targetDir, entry.name);
          const rel = this.getRelPathFromAbsolute(abs);
          return { relativePath: rel, absolutePath: abs, mimeType: this.getMimeType(entry.name) };
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  private getRelPathFromAbsolute(absPath: string): string {
    for (const base of this.sharedDirs) {
      if (isInsideDir(absPath, base) || absPath === base) {
        const rootName = path.basename(base);
        const rel = path.relative(base, absPath).replace(/\\/g, '/');
        return rel ? `${rootName}/${rel}` : rootName;
      }
    }
    return path.basename(absPath);
  }
}
