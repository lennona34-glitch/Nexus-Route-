import crypto from 'crypto';
import { UniversalRequest, UniversalResponse, UniversalStreamChunk } from '../ir/types.js';

export interface CacheEntry {
  response: UniversalResponse;
  streamChunks?: UniversalStreamChunk[];
  createdAt: number;
  expiresAt: number;
  savedCostUsd: number;
  hitCount: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRatio: number;
  totalSavedLatencyMs: number;
  totalSavedUsd: number;
  entriesCount: number;
}

export class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private maxEntries = 1000;
  private defaultTtlMs = 1000 * 60 * 60; // 1 hour
  private hits = 0;
  private misses = 0;
  private totalSavedLatencyMs = 0;
  private totalSavedUsd = 0;
  private enabled = false; // Disabled by default so small repeat commands run fresh

  constructor(options?: { maxEntries?: number; defaultTtlMs?: number; enabled?: boolean }) {
    if (options?.maxEntries) this.maxEntries = options.maxEntries;
    if (options?.defaultTtlMs) this.defaultTtlMs = options.defaultTtlMs;
    if (options?.enabled !== undefined) this.enabled = options.enabled;
  }

  private hasSideEffects(req: UniversalRequest): boolean {
    return !!((req.tools && req.tools.length > 0) || req.enable_tools === true);
  }

  generateKey(req: UniversalRequest): string {
    const normalized = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      top_p: req.top_p,
      max_tokens: req.max_tokens,
      response_format: req.response_format,
      stop: req.stop,
      tool_choice: req.tool_choice,
      art_engine: req.art_engine,
    };
    const jsonStr = JSON.stringify(normalized);
    return crypto.createHash('sha256').update(jsonStr).digest('hex');
  }

  get(req: UniversalRequest): CacheEntry | null {
    if (!this.enabled || this.hasSideEffects(req)) return null;

    const fullKey = this.generateKey(req);
    const entry = this.cache.get(fullKey);

    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(fullKey);
      this.misses++;
      return null;
    }

    this.hits++;
    entry.hitCount++;
    this.totalSavedUsd += entry.savedCostUsd;
    this.totalSavedLatencyMs += (entry.response.route_info?.total_latency_ms || 200);

    return entry;
  }

  set(req: UniversalRequest, response: UniversalResponse, streamChunks?: UniversalStreamChunk[]) {
    if (!this.enabled || this.hasSideEffects(req)) return;

    // Evict oldest if full
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    const fullKey = this.generateKey(req);
    const savedCost = response.usage?.estimated_cost_usd || 0;

    const entry: CacheEntry = {
      response,
      streamChunks,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.defaultTtlMs,
      savedCostUsd: savedCost,
      hitCount: 0,
    };

    this.cache.set(fullKey, entry);
  }

  getStats(): CacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRatio: total > 0 ? Number((this.hits / total).toFixed(4)) : 0,
      totalSavedLatencyMs: this.totalSavedLatencyMs,
      totalSavedUsd: Number(this.totalSavedUsd.toFixed(6)),
      entriesCount: this.cache.size,
    };
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.totalSavedLatencyMs = 0;
    this.totalSavedUsd = 0;
  }
}
