import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VAULT_DOMAINS, routeQueryToDomainIds, getDomainById, VaultDomain } from './vault-domains.js';

export interface ShardedLesson {
  key: string;
  category: string;
  problem: string;
  fix: string;
  scope: string;
  evidence_json?: string;
  updated_at: string;
  score?: number;
  shard?: string;
}

export interface VaultStats {
  vaultRoot: string;
  totalLessons: number;
  shardCount: number;
  freeSpaceGB: number;
  totalSpaceGB: number;
  vaultSizeMB: number;
  shards: Array<{ id: number; name: string; file: string; count: number; sizeMB: number }>;
}

export class LearningShardedStore {
  private static instance: LearningShardedStore | null = null;

  public static getDefaultVaultPath(): string {
    if (process.env.NEXUS_VAULT_DIR) return process.env.NEXUS_VAULT_DIR;
    // Check if E:\ drive is available
    if (process.platform === 'win32') {
      try {
        if (fs.existsSync('E:/')) {
          return 'E:/nexus_vault';
        }
      } catch {}
    }
    return path.resolve(process.cwd(), 'data', 'nexus_vault');
  }

  public static getInstance(customVaultPath?: string): LearningShardedStore {
    const vaultPath = customVaultPath || this.getDefaultVaultPath();
    if (!this.instance || this.instance.vaultRoot !== path.resolve(vaultPath)) {
      if (this.instance) {
        this.instance.close();
      }
      this.instance = new LearningShardedStore(vaultPath);
    }
    return this.instance;
  }

  public readonly vaultRoot: string;
  public readonly shardsDir: string;
  private metaDb: DatabaseSync;
  private shardHandles = new Map<number, DatabaseSync>();

  constructor(vaultRoot: string) {
    this.vaultRoot = path.resolve(vaultRoot);
    this.shardsDir = path.join(this.vaultRoot, 'shards');
    fs.mkdirSync(this.shardsDir, { recursive: true });

    const metaPath = path.join(this.vaultRoot, 'meta_catalog.sqlite');
    this.metaDb = new DatabaseSync(metaPath);
    this.setupMetaDb();
  }

  private setupMetaDb(): void {
    this.metaDb.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS shard_manifest (
        id INTEGER PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        file_name TEXT NOT NULL,
        lesson_count INTEGER DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
  }

  public static checkDiskSafety(targetDir: string, minFreeGB = 50): { safe: boolean; freeGB: number; totalGB: number } {
    try {
      const stats = fs.statfsSync(targetDir);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      const totalBytes = Number(stats.blocks) * Number(stats.bsize);
      const freeGB = freeBytes / (1024 * 1024 * 1024);
      const totalGB = totalBytes / (1024 * 1024 * 1024);
      return {
        safe: freeGB >= minFreeGB,
        freeGB: Math.round(freeGB * 100) / 100,
        totalGB: Math.round(totalGB * 100) / 100
      };
    } catch {
      return { safe: true, freeGB: 999, totalGB: 999 };
    }
  }

  public getShardHandle(domainId: number): DatabaseSync {
    let handle = this.shardHandles.get(domainId);
    if (handle) return handle;

    const domain = getDomainById(domainId);
    if (!domain) throw new Error(`Unknown domain id: ${domainId}`);

    const shardPath = path.join(this.shardsDir, domain.shardFile);
    handle = new DatabaseSync(shardPath);

    handle.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -64000;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 268435456;

      CREATE TABLE IF NOT EXISTS lessons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        category TEXT NOT NULL,
        problem TEXT NOT NULL,
        fix TEXT NOT NULL,
        scope TEXT NOT NULL,
        evidence_json TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lessons_key ON lessons(key);
      CREATE INDEX IF NOT EXISTS idx_lessons_category ON lessons(category);

      CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
        key,
        problem,
        fix,
        scope,
        content='lessons',
        content_rowid='id',
        tokenize = 'porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS lessons_ai AFTER INSERT ON lessons BEGIN
        INSERT INTO lessons_fts(rowid, key, problem, fix, scope) VALUES (new.id, new.key, new.problem, new.fix, new.scope);
      END;

      CREATE TRIGGER IF NOT EXISTS lessons_ad AFTER DELETE ON lessons BEGIN
        INSERT INTO lessons_fts(lessons_fts, rowid, key, problem, fix, scope) VALUES('delete', old.id, old.key, old.problem, old.fix, old.scope);
      END;

      CREATE TRIGGER IF NOT EXISTS lessons_au AFTER UPDATE ON lessons BEGIN
        INSERT INTO lessons_fts(lessons_fts, rowid, key, problem, fix, scope) VALUES('delete', old.id, old.key, old.problem, old.fix, old.scope);
        INSERT INTO lessons_fts(rowid, key, problem, fix, scope) VALUES (new.id, new.key, new.problem, new.fix, new.scope);
      END;
    `);

    this.shardHandles.set(domainId, handle);
    return handle;
  }

  public query(queryText: string, limit = 50): ShardedLesson[] {
    const trimmed = queryText.trim();
    if (!trimmed) {
      return this.queryRecent(limit);
    }

    const candidateDomainIds = routeQueryToDomainIds(trimmed);
    if (candidateDomainIds.length === 0) {
      return [];
    }
    const targetDomainIds = candidateDomainIds.slice(0, 4);

    const cleanTokens = trimmed
      .replace(/[^a-zA-Z0-9_\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2);

    if (cleanTokens.length === 0) {
      return this.queryRecent(limit);
    }

    const terms = cleanTokens.length === 1
      ? `${cleanTokens[0]}*`
      : cleanTokens.join(' AND ');

    const results: ShardedLesson[] = [];

    for (const domainId of targetDomainIds) {
      const domain = getDomainById(domainId);
      if (!domain) continue;

      const shardPath = path.join(this.shardsDir, domain.shardFile);
      if (!fs.existsSync(shardPath)) continue;

      try {
        const db = this.getShardHandle(domainId);
        // Early-exit fetch candidate set without full-shard BM25 scan overhead
        const candidateLimit = Math.min(60, Math.max(limit * 2, 20));
        const stmt = db.prepare(`
          SELECT rowid, key, problem, fix, scope
          FROM lessons_fts
          WHERE lessons_fts MATCH ?
          LIMIT ?
        `);
        const rows = stmt.all(terms, candidateLimit) as any[];
        for (const r of rows) {
          let score = 0;
          const kLower = (r.key || '').toLowerCase();
          const pLower = (r.problem || '').toLowerCase();
          for (const tok of cleanTokens) {
            if (kLower.includes(tok)) score -= 10;
            if (pLower.includes(tok)) score -= 3;
          }
          results.push({
            ...r,
            shard: domain.shardFile,
            score
          });
        }
        if (results.length >= limit) break;
      } catch {}

      if (results.length >= limit) break;
    }

    // Sort by BM25 score ascending (lower is better in SQLite bm25)
    results.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    return results.slice(0, limit);
  }

  public queryRecent(limit = 50): ShardedLesson[] {
    const results: ShardedLesson[] = [];
    const perShard = Math.max(2, Math.ceil(limit / VAULT_DOMAINS.length));

    for (const domain of VAULT_DOMAINS) {
      const shardPath = path.join(this.shardsDir, domain.shardFile);
      if (!fs.existsSync(shardPath)) continue;

      try {
        const db = this.getShardHandle(domain.id);
        const stmt = db.prepare(`
          SELECT key, category, problem, fix, scope, evidence_json, updated_at
          FROM lessons
          ORDER BY id DESC
          LIMIT ?
        `);
        const rows = stmt.all(perShard) as any[];
        for (const r of rows) {
          results.push({
            ...r,
            shard: domain.shardFile
          });
        }
      } catch {}
      if (results.length >= limit) break;
    }

    return results.slice(0, limit);
  }

  public count(): number {
    let total = 0;
    for (const domain of VAULT_DOMAINS) {
      const shardPath = path.join(this.shardsDir, domain.shardFile);
      if (!fs.existsSync(shardPath)) continue;
      try {
        const db = this.getShardHandle(domain.id);
        const row = db.prepare('SELECT count(*) as c FROM lessons;').get() as { c: number };
        if (row) total += Number(row.c);
      } catch {}
    }
    return total;
  }

  public saveLesson(lesson: { key: string; problem: string; fix: string; scope: string; category?: string; evidence_json?: string }): boolean {
    const domainIds = routeQueryToDomainIds(lesson.problem + ' ' + lesson.key + ' ' + lesson.scope);
    const domainId = domainIds.length > 0 ? domainIds[0] : 0;
    const domain = getDomainById(domainId);
    if (!domain) return false;

    try {
      const db = this.getShardHandle(domainId);
      const stmt = db.prepare(`
        INSERT INTO lessons (key, category, problem, fix, scope, evidence_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          problem = excluded.problem,
          fix = excluded.fix,
          scope = excluded.scope,
          evidence_json = excluded.evidence_json,
          updated_at = excluded.updated_at
      `);
      stmt.run(
        lesson.key,
        lesson.category || domain.name,
        lesson.problem,
        lesson.fix,
        lesson.scope,
        lesson.evidence_json || null,
        new Date().toISOString()
      );
      return true;
    } catch {
      return false;
    }
  }

  public getStats(): VaultStats {
    let totalLessons = 0;
    let vaultSizeBytes = 0;
    const shardStats: VaultStats['shards'] = [];

    for (const domain of VAULT_DOMAINS) {
      const shardPath = path.join(this.shardsDir, domain.shardFile);
      let count = 0;
      let sizeMB = 0;

      if (fs.existsSync(shardPath)) {
        try {
          const stat = fs.statSync(shardPath);
          sizeMB = Math.round((stat.size / (1024 * 1024)) * 100) / 100;
          vaultSizeBytes += stat.size;

          const db = this.getShardHandle(domain.id);
          const row = db.prepare('SELECT count(*) as c FROM lessons;').get() as { c: number };
          if (row) count = Number(row.c);
          totalLessons += count;
        } catch {}
      }

      shardStats.push({
        id: domain.id,
        name: domain.name,
        file: domain.shardFile,
        count,
        sizeMB
      });
    }

    const disk = LearningShardedStore.checkDiskSafety(this.vaultRoot, 0);

    return {
      vaultRoot: this.vaultRoot,
      totalLessons,
      shardCount: VAULT_DOMAINS.length,
      freeSpaceGB: disk.freeGB,
      totalSpaceGB: disk.totalGB,
      vaultSizeMB: Math.round((vaultSizeBytes / (1024 * 1024)) * 100) / 100,
      shards: shardStats
    };
  }

  public close(): void {
    for (const [id, handle] of this.shardHandles) {
      try { handle.close(); } catch {}
    }
    this.shardHandles.clear();
    try { this.metaDb.close(); } catch {}
  }
}
