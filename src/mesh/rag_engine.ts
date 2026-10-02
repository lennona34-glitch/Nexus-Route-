/**
 * Nexus Route - Offline Semantic Knowledge Vault & RAG Engine
 * Scans, chunks, and indexes mounted shared drives, DEV FOLDER, and workspaces
 * completely offline for instant local context retrieval.
 */

import fs from 'fs';
import path from 'path';

export interface DocumentChunk {
  id: string;
  sourceFile: string;
  fileName: string;
  category: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  terms: Set<string>;
}

export interface SearchResult {
  score: number;
  sourceFile: string;
  fileName: string;
  category: string;
  lineStart: number;
  lineEnd: number;
  content: string;
}

export class OfflineRagEngine {
  private chunks: DocumentChunk[] = [];
  private indexedDirs: string[] = [];
  private lastIndexedAt: number = 0;
  private isIndexing: boolean = false;

  constructor(initialDirs: string[] = []) {
    this.indexedDirs = initialDirs;
  }

  public setIndexedDirs(dirs: string[]): void {
    this.indexedDirs = Array.from(new Set(dirs.filter(d => fs.existsSync(d))));
  }

  public getStatus(): { indexedFiles: number; totalChunks: number; lastIndexedAt: number; indexedDirs: string[] } {
    const uniqueFiles = new Set(this.chunks.map(c => c.sourceFile));
    return {
      indexedFiles: uniqueFiles.size,
      totalChunks: this.chunks.length,
      lastIndexedAt: this.lastIndexedAt,
      indexedDirs: this.indexedDirs,
    };
  }

  /**
   * Scan directories and build index safely without blocking the event loop
   */
  public async reindex(): Promise<number> {
    if (this.isIndexing) return this.chunks.length;
    this.isIndexing = true;

    try {
      const newChunks: DocumentChunk[] = [];
      const supportedExts = new Set([
        '.md', '.txt', '.json', '.s', '.asm', '.z80', '.dsp', '.c', '.h', '.cpp',
        '.ts', '.js', '.py', '.bas', '.yaml', '.yml', '.sql', '.sh'
      ]);

      let indexedFilesCount = 0;
      const MAX_FILES = 250;

      for (const dir of this.indexedDirs) {
        if (!fs.existsSync(dir)) continue;
        await this.scanDirAsync(dir, dir, supportedExts, newChunks, 0, 3, () => {
          indexedFilesCount++;
          return indexedFilesCount >= MAX_FILES;
        });
        if (indexedFilesCount >= MAX_FILES) break;
      }

      this.chunks = newChunks;
      this.lastIndexedAt = Date.now();
      return this.chunks.length;
    } finally {
      this.isIndexing = false;
    }
  }

  private async scanDirAsync(
    rootDir: string,
    currentDir: string,
    exts: Set<string>,
    out: DocumentChunk[],
    depth: number,
    maxDepth: number,
    isCapped: () => boolean
  ): Promise<void> {
    if (depth > maxDepth || isCapped()) return;

    try {
      const entries = await fs.promises.readdir(currentDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (isCapped()) break;
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          const lower = entry.name.toLowerCase();
          if (
            entry.name.startsWith('.') ||
            lower === 'node_modules' ||
            lower === 'dist' ||
            lower === 'build' ||
            lower === 'bin' ||
            lower === 'vendor' ||
            lower === 'venv' ||
            lower === '.venv' ||
            lower === '__pycache__' ||
            lower === 'coverage'
          ) {
            continue;
          }
          await new Promise(r => setImmediate(r));
          await this.scanDirAsync(rootDir, fullPath, exts, out, depth + 1, maxDepth, isCapped);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (exts.has(ext)) {
            this.indexFile(fullPath, rootDir, out);
            if (isCapped()) break;
          }
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  private indexFile(filePath: string, rootDir: string, out: DocumentChunk[]): void {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > 1024 * 1024 * 2) return; // Skip files > 2MB

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');
      const fileName = path.basename(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const category = ext === '.s' || ext === '.asm' || ext === '.z80' ? 'retro_assembly'
        : ext === '.dsp' ? 'faust_dsp'
        : ext === '.md' || ext === '.txt' ? 'docs'
        : 'code';

      // Chunk into ~40 lines or 600 chars with overlap
      const chunkSize = 35;
      const overlap = 8;
      let i = 0;
      let chunkIdx = 0;

      while (i < lines.length) {
        const slice = lines.slice(i, i + chunkSize);
        const text = slice.join('\n').trim();
        if (text.length > 20) {
          const terms = this.tokenize(text);
          out.push({
            id: `${relPath}#chunk_${chunkIdx}`,
            sourceFile: relPath,
            fileName,
            category,
            lineStart: i + 1,
            lineEnd: Math.min(i + chunkSize, lines.length),
            content: text,
            terms,
          });
          chunkIdx++;
        }
        i += (chunkSize - overlap);
      }
    } catch {
      // Ignore parse errors
    }
  }

  private tokenize(text: string): Set<string> {
    const tokens = text.toLowerCase()
      .replace(/[^a-z0-9_\$#\.\-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2);
    return new Set(tokens);
  }

  /**
   * Search knowledge base with BM25 / TF-IDF style scoring
   */
  public search(query: string, topK: number = 4): SearchResult[] {
    const qTokens = Array.from(this.tokenize(query));
    if (qTokens.length === 0 || this.chunks.length === 0) return [];

    const results: SearchResult[] = [];

    for (const chunk of this.chunks) {
      let matchCount = 0;
      let weight = 0;

      for (const token of qTokens) {
        if (chunk.terms.has(token)) {
          matchCount++;
          // Exact filename or function match bonus
          if (chunk.fileName.toLowerCase().includes(token)) weight += 3.0;
          weight += 1.0;
        }
      }

      if (matchCount > 0) {
        const score = (weight / (qTokens.length + 1)) * (matchCount / Math.max(1, Math.log2(chunk.terms.size + 2)));
        results.push({
          score,
          sourceFile: chunk.sourceFile,
          fileName: chunk.fileName,
          category: chunk.category,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          content: chunk.content,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Augment prompt with grounded local knowledge snippets
   */
  public augmentPromptWithVault(query: string, prompt: string): string {
    const hits = this.search(query, 3);
    if (hits.length === 0) return prompt;

    const contextSnippets = hits.map(h =>
      `[FILE: ${h.sourceFile} (lines ${h.lineStart}-${h.lineEnd})]\n${h.content.slice(0, 400)}`
    ).join('\n\n');

    return `${prompt}\n\n=== RELEVANT LOCAL CODE & NOTES FROM YOUR MOUNTED SHARES ===\n${contextSnippets}\n=== END RELEVANT CONTEXT ===`;
  }
}
