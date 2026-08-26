import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { ToolCall, UniversalMessage } from '../ir/types.js';

export interface CompressionRun {
  messages: UniversalMessage[];
  stats: {
    originalChars: number;
    compressedChars: number;
    savedChars: number;
    rawBlocksStored: number;
    rawIds: string[];
  };
}

const lifetimeStats = {
  runs: 0,
  originalChars: 0,
  compressedChars: 0,
  savedChars: 0,
  rawBlocksStored: 0,
};

function rawDirectory(workspaceDir: string): string {
  return path.join(workspaceDir, 'context', 'raw');
}

function rawId(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 20);
}

function storeRaw(workspaceDir: string, content: string, kind: string): string {
  const id = rawId(content);
  const dir = rawDirectory(workspaceDir);
  fs.mkdirSync(dir, { recursive: true });
  const textPath = path.join(dir, `${id}.txt`);
  const metadataPath = path.join(dir, `${id}.json`);
  if (!fs.existsSync(textPath)) fs.writeFileSync(textPath, content, 'utf8');
  if (!fs.existsSync(metadataPath)) {
    fs.writeFileSync(metadataPath, JSON.stringify({ id, kind, chars: content.length, createdAt: Date.now() }, null, 2), 'utf8');
  }
  return id;
}

function marker(id: string, originalChars: number, preview: string): string {
  return `${preview}\n\n… [${originalChars.toLocaleString()} chars compacted safely. Raw context id: ${id}. Use recover_raw_context or GET /v1/context/raw/${id}]`;
}

function compactText(workspaceDir: string, content: string, kind: string): { content: string; id: string } {
  const id = storeRaw(workspaceDir, content, kind);
  const head = content.slice(0, 500).trimEnd();
  const tail = content.length > 900 ? `\n\n[tail]\n${content.slice(-220).trimStart()}` : '';
  return { content: marker(id, content.length, `${head}${tail}`), id };
}

function compactToolCalls(workspaceDir: string, toolCalls: ToolCall[], ids: string[]): ToolCall[] {
  return toolCalls.map(toolCall => {
    if (!toolCall.function.arguments || toolCall.function.arguments.length <= 1800) return toolCall;
    try {
      const parsed = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
      let changed = false;
      const compacted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string' && value.length > 1200) {
          const raw = compactText(workspaceDir, value, `tool_argument:${toolCall.function.name}:${key}`);
          ids.push(raw.id);
          compacted[key] = raw.content;
          changed = true;
        } else {
          compacted[key] = value;
        }
      }
      return changed
        ? { ...toolCall, function: { ...toolCall.function, arguments: JSON.stringify(compacted) } }
        : toolCall;
    } catch {
      const raw = compactText(workspaceDir, toolCall.function.arguments, `tool_arguments:${toolCall.function.name}`);
      ids.push(raw.id);
      return { ...toolCall, function: { ...toolCall.function, arguments: raw.content } };
    }
  });
}

export function compressMessages(messages: UniversalMessage[], workspaceDir: string, keepRecent = 6): CompressionRun {
  const originalChars = JSON.stringify(messages).length;
  const rawIds: string[] = [];
  const cutoff = Math.max(0, messages.length - keepRecent);
  const compressed = messages.map((message, index): UniversalMessage => {
    if (index >= cutoff) return message;

    if (message.role === 'tool' && typeof message.content === 'string' && message.content.length > 1200) {
      const raw = compactText(workspaceDir, message.content, 'tool_result');
      rawIds.push(raw.id);
      return { ...message, content: raw.content };
    }

    if (message.role === 'assistant') {
      let content = message.content;
      if (typeof content === 'string' && content.length > 5000) {
        const raw = compactText(workspaceDir, content, 'assistant_message');
        rawIds.push(raw.id);
        content = raw.content;
      }
      const toolCalls = message.tool_calls
        ? compactToolCalls(workspaceDir, message.tool_calls, rawIds)
        : undefined;
      return { ...message, content, tool_calls: toolCalls };
    }

    return message;
  });

  const compressedChars = JSON.stringify(compressed).length;
  const stats = {
    originalChars,
    compressedChars,
    savedChars: Math.max(0, originalChars - compressedChars),
    rawBlocksStored: new Set(rawIds).size,
    rawIds: [...new Set(rawIds)],
  };
  lifetimeStats.runs += 1;
  lifetimeStats.originalChars += stats.originalChars;
  lifetimeStats.compressedChars += stats.compressedChars;
  lifetimeStats.savedChars += stats.savedChars;
  lifetimeStats.rawBlocksStored += stats.rawBlocksStored;
  return { messages: compressed, stats };
}

export function recoverRawContext(workspaceDir: string, id: string): { id: string; content: string; metadata?: Record<string, unknown> } | null {
  if (!/^[a-f0-9]{20}$/.test(id)) return null;
  const textPath = path.join(rawDirectory(workspaceDir), `${id}.txt`);
  if (!fs.existsSync(textPath)) return null;
  const metadataPath = path.join(rawDirectory(workspaceDir), `${id}.json`);
  let metadata: Record<string, unknown> | undefined;
  try {
    if (fs.existsSync(metadataPath)) metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch {}
  return { id, content: fs.readFileSync(textPath, 'utf8'), metadata };
}

export function listRawContexts(workspaceDir: string): Array<{ id: string; kind?: string; chars?: number; createdAt?: number }> {
  const dir = rawDirectory(workspaceDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => /^[a-f0-9]{20}\.json$/.test(name))
    .map(name => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        return { id: path.basename(name, '.json') };
      }
    })
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

export function getCompressionStats() {
  return {
    ...lifetimeStats,
    savingsRatio: lifetimeStats.originalChars ? lifetimeStats.savedChars / lifetimeStats.originalChars : 0,
  };
}
