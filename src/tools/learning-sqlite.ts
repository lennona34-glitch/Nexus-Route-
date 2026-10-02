import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SqliteLesson {
  key: string;
  category: string;
  problem: string;
  fix: string;
  scope: string;
  evidence_json?: string;
  updated_at: string;
  score?: number;
}

export class LearningSqliteStore {
  private static instances = new Map<string, LearningSqliteStore>();

  public static getInstance(ws: string): LearningSqliteStore {
    const resolved = path.resolve(ws);
    let inst = this.instances.get(resolved);
    if (!inst) {
      inst = new LearningSqliteStore(resolved);
      this.instances.set(resolved, inst);
    }
    return inst;
  }

  private db: DatabaseSync;
  private ws: string;
  private dbPath: string;
  private ftsQueryStmt!: any;
  private recentStmt!: any;

  constructor(ws: string) {
    this.ws = path.resolve(ws);
    this.dbPath = path.join(this.ws, 'learning.sqlite');
    fs.mkdirSync(this.ws, { recursive: true });

    this.db = new DatabaseSync(this.dbPath);
    this.setupPragmas();
    this.initSchema();
    this.prepareStatements();
  }

  private setupPragmas(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -64000;
      PRAGMA temp_store = MEMORY;
      PRAGMA mmap_size = 268435456;
    `);
  }

  private initSchema(): void {
    this.db.exec(`
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

      -- Triggers for automatic FTS synchronization
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
  }

  private prepareStatements(): void {
    this.recentStmt = this.db.prepare(`
      SELECT key, category, problem, fix, scope, evidence_json, updated_at
      FROM lessons
      ORDER BY id DESC
      LIMIT ?
    `);

    this.ftsQueryStmt = this.db.prepare(`
      SELECT l.key, l.category, l.problem, l.fix, l.scope, l.evidence_json, l.updated_at,
             bm25(lessons_fts, 10.0, 1.5, 0.5, 3.0) as score
      FROM lessons_fts f
      JOIN lessons l ON l.id = f.rowid
      WHERE lessons_fts MATCH ?
      ORDER BY score ASC
      LIMIT ?
    `);
  }

  public count(): number {
    const row = this.db.prepare('SELECT count(*) as count FROM lessons').get() as { count: number };
    return row ? Number(row.count) : 0;
  }

  public save(lesson: {
    key: string;
    problem: string;
    fix: string;
    scope: string;
    evidence?: any;
    updatedAt?: string;
  }): void {
    let cat = 'General';
    if (lesson.scope && lesson.scope.includes(':')) {
      cat = lesson.scope.split(':')[1].trim();
    }
    const evidenceJson = lesson.evidence ? JSON.stringify(lesson.evidence) : null;
    const updatedAt = lesson.updatedAt || new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO lessons (key, category, problem, fix, scope, evidence_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        category = excluded.category,
        problem = excluded.problem,
        fix = excluded.fix,
        scope = excluded.scope,
        evidence_json = excluded.evidence_json,
        updated_at = excluded.updated_at
    `);
    stmt.run(lesson.key, cat, lesson.problem, lesson.fix, lesson.scope, evidenceJson, updatedAt);
  }

  public insertBatch(lessons: Array<{
    key: string;
    problem: string;
    fix: string;
    scope: string;
    evidence?: any;
    updatedAt?: string;
  }>): number {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      const stmt = this.db.prepare(`
        INSERT INTO lessons (key, category, problem, fix, scope, evidence_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          category = excluded.category,
          problem = excluded.problem,
          fix = excluded.fix,
          scope = excluded.scope,
          evidence_json = excluded.evidence_json,
          updated_at = excluded.updated_at
      `);

      for (const l of lessons) {
        let cat = 'General';
        if (l.scope && l.scope.includes(':')) {
          cat = l.scope.split(':')[1].trim();
        }
        const evidenceJson = l.evidence ? JSON.stringify(l.evidence) : null;
        const updatedAt = l.updatedAt || new Date().toISOString();
        stmt.run(l.key, cat, l.problem, l.fix, l.scope, evidenceJson, updatedAt);
      }

      this.db.exec('COMMIT;');
      return lessons.length;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  public query(search: string, limit = 10): SqliteLesson[] {
    const trimmed = search.trim();
    if (!trimmed) {
      return (this.recentStmt.all(limit) as any[]).map(r => ({
        key: r.key,
        category: r.category,
        problem: r.problem,
        fix: r.fix,
        scope: r.scope,
        evidence_json: r.evidence_json,
        updated_at: r.updated_at
      }));
    }

    // Sanitize query for FTS5 (split into tokens and append wildcard)
    const terms = trimmed
      .replace(/[^a-zA-Z0-9_\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 0)
      .map(t => `${t}*`)
      .join(' OR ');

    if (!terms) return [];

    try {
      return (this.ftsQueryStmt.all(terms, limit) as any[]).map(r => ({
        key: r.key,
        category: r.category,
        problem: r.problem,
        fix: r.fix,
        scope: r.scope,
        evidence_json: r.evidence_json,
        updated_at: r.updated_at,
        score: Number(r.score)
      }));
    } catch {
      return [];
    }
  }

  public getByKey(key: string): SqliteLesson | null {
    const stmt = this.db.prepare('SELECT key, category, problem, fix, scope, evidence_json, updated_at FROM lessons WHERE key = ?');
    const row = stmt.get(key) as any;
    if (!row) return null;
    return {
      key: row.key,
      category: row.category,
      problem: row.problem,
      fix: row.fix,
      scope: row.scope,
      evidence_json: row.evidence_json,
      updated_at: row.updated_at
    };
  }

  public close(): void {
    try {
      this.db.close();
    } catch {}
  }
}
