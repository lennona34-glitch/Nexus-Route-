import fs from 'fs';
import path from 'path';

export interface MemoryEntry {
  key: string;
  fact: string;
  category: 'preference' | 'hardware' | 'project' | 'knowledge' | 'general';
  updatedAt: string;
}

export class MemoryStore {
  private static memoryFilePath: string = '';

  private static getMemoryPath(workspaceDir: string): string {
    return path.join(workspaceDir, '.nexus_memory.json');
  }

  private static loadMemories(workspaceDir: string): Record<string, MemoryEntry> {
    const filePath = this.getMemoryPath(workspaceDir);
    if (!fs.existsSync(filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return {};
    }
  }

  private static saveMemories(workspaceDir: string, data: Record<string, MemoryEntry>) {
    const filePath = this.getMemoryPath(workspaceDir);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  static remember(
    workspaceDir: string,
    key: string,
    fact: string,
    category: 'preference' | 'hardware' | 'project' | 'knowledge' | 'general' = 'general'
  ): { success: boolean; message: string; entry: MemoryEntry } {
    const memories = this.loadMemories(workspaceDir);
    const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const entry: MemoryEntry = {
      key: cleanKey,
      fact: fact.trim(),
      category,
      updatedAt: new Date().toISOString(),
    };
    memories[cleanKey] = entry;
    this.saveMemories(workspaceDir, memories);

    return {
      success: true,
      message: `Remembered fact for topic "${cleanKey}" (${category}): "${fact.trim()}"`,
      entry,
    };
  }

  static recall(workspaceDir: string, query?: string): { success: boolean; count: number; memories: MemoryEntry[] } {
    const memories = this.loadMemories(workspaceDir);
    const all = Object.values(memories);

    if (!query || !query.trim()) {
      return {
        success: true,
        count: all.length,
        memories: all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      };
    }

    const q = query.toLowerCase().trim();
    const filtered = all.filter(m => m.key.includes(q) || m.fact.toLowerCase().includes(q) || m.category.includes(q));

    return {
      success: true,
      count: filtered.length,
      memories: filtered,
    };
  }
}
