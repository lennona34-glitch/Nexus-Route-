import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { RouteMetadata, UniversalUsage } from '../ir/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface RouteHistoryRecord {
  id: string;
  timestamp: number;
  requestedModel: string;
  provider: string;
  model: string;
  connectionId?: string;
  connectionLabel?: string;
  success: boolean;
  cached: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  attempts: RouteMetadata['attempts'];
  decisionReasons: string[];
  compression?: RouteMetadata['compression'];
  requestId?: string;
  toolsExecuted?: string[];
  filesWritten?: RouteMetadata['files_written'];
  turnCount?: number;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

export class RouteTelemetryStore {
  private records: RouteHistoryRecord[] = [];
  private storagePath: string | null;
  private maxRecords: number;

  constructor(options: { storagePath?: string | null; maxRecords?: number } = {}) {
    this.storagePath = options.storagePath === undefined
      ? path.join(__dirname, '../../config/route_history.json')
      : options.storagePath;
    this.maxRecords = options.maxRecords || 250;
    this.load();
  }

  private load(): void {
    if (!this.storagePath || !fs.existsSync(this.storagePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8')) as RouteHistoryRecord[];
      if (Array.isArray(parsed)) this.records = parsed.slice(-this.maxRecords);
    } catch {}
  }

  private save(): void {
    if (!this.storagePath) return;
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.records, null, 2), 'utf8');
    } catch {}
  }

  record(input: {
    requestedModel: string;
    routeInfo: RouteMetadata;
    usage?: UniversalUsage;
    success?: boolean;
  }): RouteHistoryRecord {
    const usage = input.usage;
    const record: RouteHistoryRecord = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      requestedModel: input.requestedModel,
      provider: input.routeInfo.selected_provider,
      model: input.routeInfo.selected_model,
      connectionId: input.routeInfo.selected_connection_id,
      connectionLabel: input.routeInfo.selected_connection_label,
      success: input.success !== false,
      cached: !!input.routeInfo.cached,
      latencyMs: input.routeInfo.total_latency_ms,
      promptTokens: usage?.prompt_tokens || 0,
      completionTokens: usage?.completion_tokens || 0,
      totalTokens: usage?.total_tokens || 0,
      estimatedCostUsd: usage?.estimated_cost_usd || 0,
      attempts: input.routeInfo.attempts,
      decisionReasons: input.routeInfo.decision_reasons || [],
      compression: input.routeInfo.compression,
      requestId: input.routeInfo.request_id,
      toolsExecuted: input.routeInfo.tools_executed,
      filesWritten: input.routeInfo.files_written,
      turnCount: input.routeInfo.turn_count,
    };
    this.records.push(record);
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
    this.save();
    return record;
  }

  list(limit = 50): RouteHistoryRecord[] {
    return this.records.slice(-Math.max(1, Math.min(limit, this.maxRecords))).reverse();
  }

  clear(): void {
    this.records = [];
    this.save();
  }

  summary() {
    const total = this.records.length;
    const successful = this.records.filter(record => record.success);
    const latencies = successful.filter(record => !record.cached).map(record => record.latencyMs);
    const providers: Record<string, { requests: number; successes: number; averageLatencyMs: number; totalCostUsd: number; totalTokens: number }> = {};
    for (const record of this.records) {
      const current = providers[record.provider] || { requests: 0, successes: 0, averageLatencyMs: 0, totalCostUsd: 0, totalTokens: 0 };
      current.requests += 1;
      if (record.success) current.successes += 1;
      current.totalCostUsd += record.estimatedCostUsd;
      current.totalTokens += record.totalTokens;
      providers[record.provider] = current;
    }
    for (const [provider, current] of Object.entries(providers)) {
      const providerLatencies = this.records.filter(record => record.provider === provider && record.success && !record.cached).map(record => record.latencyMs);
      current.averageLatencyMs = providerLatencies.length
        ? Math.round(providerLatencies.reduce((sum, value) => sum + value, 0) / providerLatencies.length)
        : 0;
    }
    return {
      totalRequests: total,
      successfulRequests: successful.length,
      successRate: total ? successful.length / total : 0,
      p50LatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      totalCostUsd: this.records.reduce((sum, record) => sum + record.estimatedCostUsd, 0),
      totalTokens: this.records.reduce((sum, record) => sum + record.totalTokens, 0),
      providers,
    };
  }
}
